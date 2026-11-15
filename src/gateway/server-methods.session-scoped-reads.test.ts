import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { PreparedModelRuntimePublicationSupersededError } from "../agents/prepared-model-runtime.errors.js";
import { registerAgentWorkspaceAccess } from "../agents/workspace-access.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import * as sessions from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as sessionDiff from "../sessions/session-diff.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import { gatewayRequest } from "./request-frame.test-support.js";
import { createSessionMessageSubscriberRegistry } from "./server-chat-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import { chatHistoryHandlers } from "./server-methods/chat-history-handler.js";
import { createHistoryReadContext } from "./server-methods/chat-history.test-helpers.js";
import { createLazyCoreHandlers } from "./server-methods/lazy-core-handlers.js";
import { sessionsDiffHandlers } from "./server-methods/sessions-diff.js";
import * as fileAssets from "./server-methods/sessions-file-assets.js";
import { sessionsFilesHandlers } from "./server-methods/sessions-files.js";
import { fetchSessionFileDownload } from "./server-methods/sessions-files.test-support.js";
import { sessionReadHandlers } from "./server-methods/sessions-read.js";
import { sessionRewindHandlers } from "./server-methods/sessions-rewind.js";
import { sessionSubscriptionHandlers } from "./server-methods/sessions-subscriptions.js";
import * as workspace from "./server-methods/workspace-files.js";
import { roleClient, rolePolicyConfig, sharingPolicyClient } from "./session-sharing.test-utils.js";

const profileState = { scenario: "minimal", prepareProfileCatalog: true } as const;

afterEach(() => vi.restoreAllMocks());

const methods = [
  "sessions.diff",
  "sessions.files.list",
  "sessions.files.get",
  "sessions.files.assets",
  "sessions.branches.list",
] as const;
const key = "agent:main:scoped-read";
const scope = { agentId: "main", sessionKey: key };
const seed = (entry: Parameters<typeof sessions.upsertSessionEntryCore>[1]) =>
  sessions.upsertSessionEntryCore(scope, entry);
const createdActor = (client: ReturnType<typeof roleClient>) => ({
  type: "human" as const,
  source: "profile" as const,
  id: client.authenticatedUserProfile!.profileId,
});

function withScopedReader(
  label: string,
  run: (fixture: {
    state: OpenClawTestState;
    reader: ReturnType<typeof roleClient>;
    cfg: OpenClawConfig;
    context: ReturnType<typeof createDirectChatContext>;
  }) => Promise<void>,
  options: { role?: Parameters<typeof roleClient>[0]; cfg?: OpenClawConfig } = {},
) {
  return withOpenClawTestState(profileState, async (state) => {
    const reader = roleClient(options.role ?? "view", label);
    reader.connect.scopes = ["operator.sessions.read"];
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    prepareGatewayRecipientProfile(reader);
    const cfg = options.cfg ?? rolePolicyConfig();
    setRuntimeConfigSnapshot(cfg);
    await run({
      state,
      reader,
      cfg,
      context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
    });
  });
}

function dispatchRead(
  method: (typeof methods)[number],
  options: Omit<
    Parameters<typeof handleGatewayRequest>[0],
    "req" | "isWebchatConnect" | "extraHandlers"
  >,
) {
  return handleGatewayRequest({
    ...options,
    req: gatewayRequest(method, method, {
      sessionKey: key,
      agentId: "main",
      ...(method === "sessions.files.get" || method === "sessions.files.assets"
        ? { path: "note.txt" }
        : {}),
      ...(method === "sessions.files.assets" ? { refs: [] } : {}),
    }),
    isWebchatConnect: () => false,
    extraHandlers: { ...sessionsDiffHandlers, ...sessionsFilesHandlers, ...sessionRewindHandlers },
  });
}

function prepareRead(method: (typeof methods)[number], beforeReturn: () => Promise<void>) {
  if (method === "sessions.diff") {
    return vi.spyOn(sessionDiff, "loadCheckoutDiff").mockImplementation(async () => {
      await beforeReturn();
      return { sessionKey: key, files: [], additions: 0, deletions: 0 };
    });
  }
  if (method === "sessions.files.assets") {
    return vi.spyOn(fileAssets, "getSessionWorkspaceAssets").mockImplementation(async () => {
      await beforeReturn();
      return { assets: [] };
    });
  }
  if (method === "sessions.files.list") {
    return vi.spyOn(workspace, "listSessionWorkspaceFiles").mockImplementation(async () => {
      await beforeReturn();
      return { files: [] };
    });
  }
  if (method === "sessions.files.get") {
    return vi.spyOn(workspace, "getSessionWorkspaceFile").mockImplementation(async () => {
      await beforeReturn();
      return {
        file: {
          path: "note.txt",
          name: "note.txt",
          content: "visible content",
          kind: "read",
          missing: false,
        },
      };
    });
  }
  return vi.spyOn(sessions, "listSessionBranches").mockImplementation(async () => {
    await beforeReturn();
    return { status: "ok", branches: [] };
  });
}

describe("narrow session read owners", () => {
  it("admits CSP previews for session-only readers and revokes resources when sharing ends", async () => {
    await withScopedReader("preview-reader", async ({ state, reader, context }) => {
      reader.connId = "narrow-preview";
      const controller = new AbortController();
      reader.connectionSignal = controller.signal;
      using _ = { [Symbol.dispose]: () => controller.abort() };
      const owner = roleClient("view", "preview-owner");
      const policy =
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
      const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><script defer src="app.js"></script></head><body>Preview</body></html>`;
      const code = "window.previewReady = true;";
      await fs.writeFile(path.join(state.workspaceDir, "index.html"), html);
      await fs.writeFile(path.join(state.workspaceDir, "app.js"), code);
      const entry = {
        sessionId: "preview-session",
        updatedAt: 1,
        visibility: "shared" as const,
        spawnedCwd: state.workspaceDir,
        permissionMode: "read-only" as const,
        createdActor: createdActor(owner),
      };
      await seed(entry);
      const respond = vi.fn();
      const dispatch = (document = html) =>
        handleGatewayRequest({
          req: gatewayRequest("preview", "sessions.files.preview", {
            sessionKey: key,
            path: "index.html",
            html: document,
          }),
          client: reader,
          context,
          respond,
          isWebchatConnect: () => false,
          extraHandlers: sessionsFilesHandlers,
        });
      await dispatch();
      expect(respond.mock.calls[0]?.[0], JSON.stringify(respond.mock.calls[0])).toBe(true);
      const preview = respond.mock.calls[0]?.[1] as {
        status: string;
        sandboxPath: string;
        html: string;
      };
      expect(preview.status).toBe("ready");
      expect(preview.html).toBe(html);
      const resource = new URL("app.js", "http://preview.invalid" + preview.sandboxPath).pathname;
      const fetched = await fetchSessionFileDownload(reader, resource);
      expect(fetched.response.statusCode).toBe(200);
      expect(Buffer.from(fetched.body as Uint8Array).toString()).toBe(code);
      for (const css of ["body{color:black}", "/*a".repeat(21_846).slice(0, 65_536)]) {
        await fs.writeFile(path.join(state.workspaceDir, "style.css"), css);
        respond.mockClear();
        await dispatch(
          html.replace(
            '<script defer src="app.js"></script>',
            '<link rel="stylesheet" href="style.css">',
          ),
        );
        expect(respond.mock.calls[0]?.[0], JSON.stringify(respond.mock.calls[0])).toBe(true);
        expect(respond.mock.calls[0]?.[1]?.status).toBe(
          css.startsWith("/*") ? "unsupported" : "ready",
        );
      }
      await seed({ ...entry, visibility: "draft", updatedAt: 2 });
      expect((await fetchSessionFileDownload(reader, resource)).response.statusCode).toBe(404);
      respond.mockClear();
      await dispatch();
      expect(respond.mock.calls[0]?.[0]).toBe(false);
      expect(respond.mock.calls[0]?.[1]).toBeUndefined();
    });
  });

  it("authorizes original-byte downloads for session-only VIEW readers and revokes HTTP grants with sharing", async () => {
    await withScopedReader("download-reader", async ({ state, reader, context }) => {
      reader.connId = "narrow-download";
      const controller = new AbortController();
      reader.connectionSignal = controller.signal;
      using _ = { [Symbol.dispose]: () => controller.abort() };
      const owner = roleClient("view", "download-owner");
      const bytes = Buffer.alloc(600_001, 0xff);
      await fs.writeFile(path.join(state.workspaceDir, "original.bin"), bytes);
      const entry = {
        sessionId: "download-session",
        updatedAt: 1,
        visibility: "shared" as const,
        spawnedCwd: state.workspaceDir,
        permissionMode: "read-only" as const,
        createdActor: createdActor(owner),
      };
      await seed(entry);
      const respond = vi.fn();
      const dispatch = () =>
        handleGatewayRequest({
          req: gatewayRequest("download", "sessions.files.download", {
            sessionKey: key,
            path: "original.bin",
          }),
          client: reader,
          context,
          respond,
          isWebchatConnect: () => false,
          extraHandlers: sessionsFilesHandlers,
        });
      await dispatch();
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      const download = respond.mock.calls[0]?.[1] as { url: string; filename: string };
      expect(download.filename).toBe("original.bin");
      await seed({ ...entry, updatedAt: 2, label: "Renamed while downloading" });
      const fetched = await fetchSessionFileDownload(reader, download.url);
      expect(fetched.response.statusCode).toBe(200);
      expect(Buffer.from(fetched.body as Uint8Array).toString("hex")).toBe(bytes.toString("hex"));
      await seed({ ...entry, visibility: "draft", updatedAt: 3 });
      expect((await fetchSessionFileDownload(reader, download.url)).response.statusCode).toBe(404);
      respond.mockClear();
      await dispatch();
      expect(respond.mock.calls[0]?.[0]).toBe(false);
      expect(respond.mock.calls[0]?.[1]).toBeUndefined();
    });
  });

  it.each([false, true])(
    "binds describe and message subscriptions to visible rows (roles=%s)",
    async (roles) => {
      await withScopedReader(
        "row-reader",
        async ({ state, reader, cfg }) => {
          const owner = roleClient("view", "row-owner");
          await state.writeConfig(cfg);
          const subscribers = createSessionMessageSubscriberRegistry();
          const context = await createHistoryReadContext({
            getRuntimeConfig: () => cfg,
            subscribeSessionMessageEvents: subscribers.subscribe,
          });
          const rows = [
            { name: "missing-before-write", own: false, visibility: "shared", visible: false },
            { name: "own-draft", own: true, visibility: "draft", visible: true },
            { name: "shared", own: false, visibility: "shared", visible: true },
            { name: "foreign-draft", own: false, visibility: "draft", visible: false },
            { name: "incognito", own: true, visibility: "shared", visible: false },
            { name: "missing", own: false, visibility: "shared", visible: false },
          ] as const;
          for (const row of rows) {
            const sessionKey = `agent:main:read-${row.name}`;
            if (!row.name.startsWith("missing")) {
              await sessions.upsertSessionEntryCore(
                { agentId: "main", sessionKey },
                {
                  sessionId: row.name,
                  updatedAt: 1,
                  visibility: row.visibility,
                  ...(row.name === "incognito" ? { incognito: true } : {}),
                  createdActor: createdActor(row.own ? reader : owner),
                },
              );
            }
            for (const method of ["sessions.describe", "sessions.messages.subscribe"] as const) {
              if (method === "sessions.describe" && row.name === "own-draft") {
                sessionChanges.emit({ all: true, scope: "config" });
              }
              const client = { ...reader, connId: `${method}-${row.name}` };
              const respond = vi.fn();
              await handleGatewayRequest({
                req: gatewayRequest(client.connId, method, { key: sessionKey, agentId: "main" }),
                client,
                context,
                respond,
                isWebchatConnect: () => false,
                extraHandlers: { ...sessionReadHandlers, ...sessionSubscriptionHandlers },
              });
              if (method === "sessions.describe") {
                expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
                  session: row.visible ? expect.objectContaining({ key: sessionKey }) : null,
                });
              } else if (row.visible) {
                expect(respond).toHaveBeenCalledExactlyOnceWith(
                  true,
                  { subscribed: true, key: sessionKey, agentId: "main" },
                  undefined,
                );
              } else {
                expect(respond).toHaveBeenCalledExactlyOnceWith(
                  false,
                  undefined,
                  expect.objectContaining({
                    code: "INVALID_REQUEST",
                    message: expect.stringContaining("was not found"),
                  }),
                );
              }
              expect(subscribers.get(sessionKey).has(client.connId)).toBe(
                method === "sessions.messages.subscribe" && row.visible,
              );
            }
          }
          reader.connect.scopes = ["operator.read"];
          const respond = vi.fn();
          await handleGatewayRequest({
            req: gatewayRequest("broad-describe", "sessions.describe", {
              key: "agent:main:read-foreign-draft",
            }),
            client: reader,
            context,
            respond,
            isWebchatConnect: () => false,
            extraHandlers: sessionReadHandlers,
          });
          expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
            session: roles
              ? null
              : expect.objectContaining({ key: "agent:main:read-foreign-draft" }),
          });
        },
        { cfg: roles ? rolePolicyConfig() : {} },
      );
    },
  );

  it.each(["current", "source", "generation"] as const)(
    "keeps the original %s through message subscription preparation",
    async (change) => {
      await withScopedReader("subscription-reader", async ({ reader: client, cfg }) => {
        client.connId = "subscription-reader";
        const entry = {
          sessionId: "original",
          lifecycleRevision: "original",
          updatedAt: 1,
          visibility: "shared" as const,
        };
        await seed(entry);
        const subscribers = createSessionMessageSubscriberRegistry();
        const context = createDirectChatContext({
          getRuntimeConfig: () => cfg,
          subscribeSessionMessageEvents: subscribers.subscribe,
        });
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const respond = vi.fn();
        let current = true;
        const request = handleGatewayRequest({
          req: gatewayRequest(change, "sessions.messages.subscribe", { key, agentId: "main" }),
          client,
          context,
          respond,
          isWebchatConnect: () => false,
          hasCurrentClientAuthority: () => current,
          extraHandlers: createLazyCoreHandlers({
            methods: ["sessions.messages.subscribe"],
            loadHandlers: async () => {
              entered.resolve();
              await release.promise;
              return sessionSubscriptionHandlers;
            },
          }),
        });
        const outcome = Promise.allSettled([request]);
        try {
          await Promise.race([entered.promise, request]);
          expect(respond, JSON.stringify(respond.mock.calls)).not.toHaveBeenCalled();
          if (change === "source") {
            current = false;
          }
          if (change === "generation") {
            await seed({ ...entry, lifecycleRevision: "replacement", sessionId: "replacement" });
          }
        } finally {
          release.resolve();
          await outcome;
        }
        if (change === "source") {
          expect(await outcome).toMatchObject([
            { status: "rejected", reason: { message: "Gateway requester authority changed" } },
          ]);
          expect(respond).not.toHaveBeenCalled();
        } else {
          expect(await outcome).toEqual([{ status: "fulfilled", value: undefined }]);
          if (change === "current") {
            expect(respond).toHaveBeenCalledExactlyOnceWith(
              true,
              { subscribed: true, key, agentId: "main" },
              undefined,
            );
          } else {
            expect(respond).toHaveBeenCalledExactlyOnceWith(
              false,
              undefined,
              expect.objectContaining({ code: "INVALID_REQUEST" }),
            );
          }
        }
        expect(subscribers.get(key).has(client.connId)).toBe(change === "current");
      });
    },
  );

  it.each(["chat.metadata", "chat.startup"] as const)(
    "%s hides foreign draft metadata and rechecks held shared reads",
    async (method) => {
      await withScopedReader("metadata-reader", async ({ state, reader: client, cfg }) => {
        const owner = roleClient("view", "metadata-owner");
        await state.writeConfig(cfg);
        const entry = {
          sessionId: "metadata-session",
          updatedAt: 1,
          createdActor: createdActor(owner),
        };
        for (const grant of ["operator.read", "operator.sessions.read"]) {
          client.connect.scopes = [grant];
          for (const visibility of ["draft", "shared", "changed"] as const) {
            await seed({
              ...entry,
              visibility: visibility === "draft" ? "draft" : "shared",
            });
            const entered = createDeferredCore();
            const release = createDeferredCore();
            const metadata = { commands: [], models: [], swarmEnabled: false };
            const readMetadata = vi.fn(async () => {
              entered.resolve();
              if (visibility === "changed") {
                await release.promise;
              }
              return metadata;
            });
            const context = await createHistoryReadContext({
              getRuntimeConfig: () => cfg,
              ...(method === "chat.metadata"
                ? { readChatMetadata: readMetadata }
                : {
                    readChatStartupProjection: async () => ({
                      metadata: await readMetadata(),
                      sessionModelCatalog: [],
                      defaultModelCatalog: [],
                    }),
                  }),
            });
            const respond = vi.fn();
            const request = handleGatewayRequest({
              req: gatewayRequest(`${grant}-${visibility}`, method, {
                agentId: "main",
                sessionKey: key,
              }),
              client,
              context,
              respond,
              isWebchatConnect: () => false,
              extraHandlers: chatHistoryHandlers,
            });
            const outcome = Promise.allSettled([request]);
            try {
              if (visibility === "changed") {
                await Promise.race([entered.promise, request]);
                expect(readMetadata).toHaveBeenCalledOnce();
                await seed({ ...entry, visibility: "draft" });
              }
            } finally {
              release.resolve();
              await outcome;
            }
            expect(readMetadata).toHaveBeenCalledTimes(visibility === "draft" ? 0 : 1);
            const settled = await outcome;
            if (method === "chat.metadata" && visibility === "changed") {
              expect(settled).toMatchObject([
                {
                  status: "rejected",
                  reason: {
                    message: "Session changed while preparing its metadata. Retry the request.",
                  },
                },
              ]);
              expect(settled[0]).toHaveProperty(
                "reason",
                expect.any(PreparedModelRuntimePublicationSupersededError),
              );
              expect(respond).not.toHaveBeenCalled();
            } else {
              expect(settled).toEqual([{ status: "fulfilled", value: undefined }]);
              expect(respond).toHaveBeenCalledOnce();
              expect(respond.mock.calls[0]?.[0]).toBe(visibility === "shared");
              if (visibility !== "shared") {
                expect(respond.mock.calls[0]?.[1]).toBeUndefined();
              }
            }
          }
        }
      });
    },
  );

  it("separates a trusted solo operator from its sharing exemption", async () => {
    const method = "sessions.files.get";
    await withOpenClawTestState(profileState, async () => {
      setRuntimeConfigSnapshot({});
      const client = sharingPolicyClient({
        user: GATEWAY_OWNER_PROFILE_ID,
        scopes: ["operator.sessions.read"],
      });
      client.internal = {
        operatorRoleActor: { kind: "operator", profileId: GATEWAY_OWNER_PROFILE_ID },
      };
      await seed({
        sessionId: "solo-session",
        updatedAt: 1,
        createdActor: { type: "human", source: "profile", id: GATEWAY_OWNER_PROFILE_ID },
      });
      for (const changed of [false, true]) {
        client.internal.operatorRoleActor = {
          kind: "operator",
          profileId: GATEWAY_OWNER_PROFILE_ID,
        };
        const io = prepareRead(method, async () => {
          if (changed) {
            client.internal!.operatorRoleActor = {
              kind: "operator",
              profileId: "another-person",
            };
          }
        });
        const respond = vi.fn();
        await dispatchRead(method, {
          client,
          context: createDirectChatContext(),
          respond,
        });
        expect(io).toHaveBeenCalledOnce();
        expect(respond.mock.calls[0]?.[0]).toBe(!changed);
        if (changed) {
          expect(respond.mock.calls[0]?.[1]).toBeUndefined();
        }
        io.mockRestore();
      }
    });
  });

  it.each(
    methods.flatMap((method) => (["none", "view"] as const).map((role) => ({ method, role }))),
  )("$method enforces $role read access", async ({ method, role }) => {
    await withScopedReader(
      "scoped-reader",
      async ({ reader, cfg, context }) => {
        const owner = roleClient("view", "scoped-owner");
        cfg.gateway!.roles!.definitions[role]!.scopes.push("operator.admin");
        setRuntimeConfigSnapshot(cfg);
        const io = prepareRead(method, async () => {});
        const request = async () => {
          const respond = vi.fn();
          await dispatchRead(method, {
            client: reader,
            context,
            respond,
          });
          return respond;
        };
        for (const visibility of ["draft", "shared"] as const) {
          await seed({
            sessionId: "scoped-read",
            updatedAt: 1,
            visibility,
            createdActor: createdActor(owner),
          });
          io.mockClear();
          const response = await request();
          const visible = visibility === "shared" && role === "view";
          expect(response.mock.calls[0]?.[0], JSON.stringify(response.mock.calls)).toBe(visible);
          expect(io).toHaveBeenCalledTimes(visible ? 1 : 0);
        }
        // Broad nonadmin readers use the same visibility owner; adding narrow write cannot bypass it.
        await seed({
          sessionId: "scoped-read",
          updatedAt: 2,
          visibility: "draft",
          createdActor: createdActor(owner),
        });
        reader.connect.scopes = ["operator.read", "operator.sessions.write"];
        expect((await request()).mock.calls[0]?.[0]).toBe(false);
        reader.connect.scopes = ["operator.admin"];
        expect((await request()).mock.calls[0]?.[0]).toBe(true);
        reader.connect.scopes = ["operator.sessions.read"];
        reader.authenticatedUserProfile = owner.authenticatedUserProfile;
        expect((await request()).mock.calls[0]?.[0]).toBe(true);
      },
      { role },
    );
  });

  it.each(methods)("%s retains only current session read facts", async (method) => {
    await withScopedReader("retained-reader", async ({ state, reader, context }) => {
      for (const changed of [
        "metadata-no-revision",
        "metadata",
        "authority",
        "generation",
        "visibility",
        ...(method === "sessions.branches.list"
          ? []
          : (["reset", "archive", "workspace"] as const)),
      ] as const) {
        const metadataOnly = changed === "metadata-no-revision" || changed === "metadata";
        const entry = {
          sessionId: "original",
          lifecycleRevision: changed === "metadata-no-revision" ? undefined : "original",
          updatedAt: 1,
          visibility: "shared" as const,
          archivedAt: undefined,
          spawnedWorkspaceDir: state.workspaceDir,
        };
        await seed(entry);
        if (changed === "metadata-no-revision") {
          expect(
            sessions.loadSessionEntry({ agentId: "main", sessionKey: key })?.lifecycleRevision,
          ).toBeUndefined();
        }
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const io = prepareRead(method, async () => {
          entered.resolve();
          await release.promise;
        });
        let current = true;
        const respond = vi.fn();
        const request = dispatchRead(method, {
          client: reader,
          context,
          respond,
          hasCurrentClientAuthority: () => current,
        });
        const outcome = Promise.allSettled([request]);
        try {
          await Promise.race([entered.promise, request]);
          expect(io).toHaveBeenCalledOnce();
          expect(respond).not.toHaveBeenCalled();
          if (changed === "authority") {
            current = false;
          } else {
            await seed({
              ...entry,
              ...(metadataOnly
                ? {
                    label: "Renamed during read",
                    updatedAt: 2,
                    lastActivityAt: 2,
                    totalTokens: 10,
                  }
                : changed === "generation"
                  ? { lifecycleRevision: "replacement" }
                  : changed === "reset"
                    ? { sessionId: "replacement" }
                    : changed === "archive"
                      ? { archivedAt: 2 }
                      : changed === "workspace"
                        ? { spawnedWorkspaceDir: path.join(state.workspaceDir, "replacement") }
                        : { visibility: "draft" }),
            });
          }
        } finally {
          release.resolve();
          await outcome;
          io.mockRestore();
        }
        const settled = await outcome;
        if (changed === "authority") {
          expect(settled).toMatchObject([
            { status: "rejected", reason: { message: "Gateway requester authority changed" } },
          ]);
          expect(respond).not.toHaveBeenCalled();
        } else {
          expect(settled).toEqual([{ status: "fulfilled", value: undefined }]);
          expect(respond).toHaveBeenCalledOnce();
          const response = respond.mock.calls[0];
          const scenario = `${method}/${changed}: ${JSON.stringify(response)}`;
          expect.soft(response?.[0], scenario).toBe(metadataOnly);
          expect
            .soft(response?.[1], scenario)
            .toEqual(
              metadataOnly
                ? method === "sessions.branches.list"
                  ? { branches: [] }
                  : method === "sessions.files.assets"
                    ? { assets: [] }
                    : expect.objectContaining({ sessionKey: key })
                : undefined,
            );
        }
      }
    });
  });

  it("rechecks session visibility before fetching a remote file after stat", async () => {
    await withScopedReader("remote-reader", async ({ state, reader, context }) => {
      for (const revoke of [false, true]) {
        const entry = {
          sessionId: "remote-read",
          lifecycleRevision: "original",
          updatedAt: 1,
          visibility: "shared" as const,
          spawnedWorkspaceDir: state.workspaceDir,
        };
        await seed(entry);
        const entered = createDeferredCore();
        const release = createDeferredCore();
        let stats = 0;
        const readFile = vi.fn(async () => Buffer.from("remote content"));
        const unregister = registerAgentWorkspaceAccess(state.workspaceDir, {
          bridge: {
            readFile,
            writeFile: async () => {
              throw new Error("unexpected write");
            },
            stat: async () => {
              if (++stats === 2) {
                entered.resolve();
                await release.promise;
              }
              return { type: "file", size: 14, mtimeMs: 1 };
            },
          },
        });
        const respond = vi.fn();
        const request = handleGatewayRequest({
          req: gatewayRequest(`remote-${revoke}`, "sessions.files.get", {
            sessionKey: key,
            agentId: "main",
            path: "note.txt",
          }),
          client: reader,
          context,
          respond,
          isWebchatConnect: () => false,
          extraHandlers: sessionsFilesHandlers,
        });
        const settled = Promise.allSettled([request]);
        try {
          await Promise.race([entered.promise, request]);
          expect(stats).toBe(2);
          expect(readFile).not.toHaveBeenCalled();
          if (revoke) {
            await seed({ ...entry, visibility: "draft", updatedAt: 2 });
          }
        } finally {
          release.resolve();
          await settled;
          unregister();
        }
        expect(readFile).toHaveBeenCalledTimes(revoke ? 0 : 1);
        expect(respond).toHaveBeenCalledOnce();
        expect(respond.mock.calls[0]?.[0]).toBe(!revoke);
        if (revoke) {
          expect(respond.mock.calls[0]?.[1]).toBeUndefined();
        } else {
          expect(respond.mock.calls[0]?.[1]).toMatchObject({ file: { content: "remote content" } });
        }
      }
    });
  });

  it.each([
    ["sessions.files.get", "narrow"],
    ["sessions.branches.list", "narrow"],
    ["sessions.files.get", "solo"],
    ["sessions.files.get", "internal"],
  ] as const)("%s keeps missing-row access for %s callers", async (method, identity) => {
    await withOpenClawTestState(profileState, async () => {
      const cfg = identity === "narrow" ? rolePolicyConfig() : {};
      setRuntimeConfigSnapshot(cfg);
      const client =
        identity === "internal"
          ? null
          : identity === "solo"
            ? sharingPolicyClient({ user: GATEWAY_OWNER_PROFILE_ID, scopes: ["operator.read"] })
            : roleClient("view", "missing-reader");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      if (client) {
        prepareGatewayRecipientProfile(client);
      }
      if (identity === "narrow" && client) {
        client.connect.scopes = ["operator.sessions.read"];
      }
      const io = prepareRead(method, async () => {});
      const respond = vi.fn();
      await dispatchRead(method, {
        client,
        context: createDirectChatContext({
          getRuntimeConfig: () => cfg,
        }),
        respond,
      });
      expect(io).toHaveBeenCalledTimes(identity === "narrow" ? 0 : 1);
      expect(respond.mock.calls[0]?.[0]).toBe(
        identity !== "narrow" || method === "sessions.branches.list",
      );
      if (identity === "narrow") {
        expect(respond.mock.calls[0]?.[1]).toEqual(
          method === "sessions.branches.list" ? { branches: [] } : undefined,
        );
      }
    });
  });
});
