import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { registerAgentWorkspaceAccess } from "../agents/workspace-access.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import * as sessions from "../config/sessions/session-accessor.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import { createSessionMessageSubscriberRegistry } from "./server-chat-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import {
  createRequestGate,
  expectRejectedOnce,
} from "./server-methods.request-gate.test-support.js";
import { chatHistoryHandlers } from "./server-methods/chat-history-handler.js";
import { createHistoryReadContext } from "./server-methods/chat-history.test-helpers.js";
import { createLazyCoreHandlers } from "./server-methods/lazy-core-handlers.js";
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
  "sessions.files.list",
  "sessions.files.get",
  "sessions.files.assets",
  "sessions.branches.list",
] as const;
const key = "agent:main:scoped-read";
type ReadClient = ReturnType<typeof roleClient>;
type SessionEntry = Parameters<typeof sessions.upsertSessionEntryCore>[1];

async function prepareReader(reader: ReadClient | null, cfg = rolePolicyConfig(), narrow = true) {
  const catalog = await prepareUserProfileCatalog();
  if (reader) {
    prepareGatewayRecipientProfile(reader);
    if (narrow) {
      reader.connect.scopes = ["operator.sessions.read"];
    }
  }
  setRuntimeConfigSnapshot(cfg);
  let cachedContext: ReturnType<typeof createDirectChatContext> | undefined;
  const context = () =>
    (cachedContext ??= createDirectChatContext({ getRuntimeConfig: () => cfg }));
  const start = (
    method: string,
    params: Record<string, unknown>,
    options: Partial<RequestOptions> = {},
  ) => {
    const respond = vi.fn();
    const request = dispatchRequest(method, params, {
      client: reader,
      ...options,
      context: options.context ?? context(),
      respond,
    });
    const outcome = Promise.allSettled([request]);
    return {
      respond,
      request,
      outcome,
      during: (gate: ReturnType<typeof createRequestGate>, inspect: () => void | Promise<void>) =>
        gate.during(request, inspect, outcome),
    };
  };
  return {
    cfg,
    start,
    read: (method: (typeof methods)[number], options: Partial<RequestOptions> = {}) =>
      start(method, readParams(method), {
        extraHandlers: { ...sessionsFilesHandlers, ...sessionRewindHandlers },
        ...options,
      }),
    [Symbol.dispose]: catalog.release,
  };
}

type RequestOptions = Omit<Parameters<typeof handleGatewayRequest>[0], "req" | "isWebchatConnect">;

async function expectReadSettlement(
  outcome: Promise<PromiseSettledResult<void>[]>,
  respond: unknown,
  revoked = false,
) {
  if (revoked) {
    expect(await outcome).toMatchObject([
      { status: "rejected", reason: { message: "Gateway requester authority changed" } },
    ]);
    expect(respond).not.toHaveBeenCalled();
  } else {
    expect(await outcome).toEqual([{ status: "fulfilled", value: undefined }]);
    expect(respond).toHaveBeenCalledOnce();
  }
}

function dispatchRequest(method: string, params: Record<string, unknown>, options: RequestOptions) {
  return handleGatewayRequest({
    ...options,
    req: { type: "req", id: method, method, params },
    isWebchatConnect: () => false,
  });
}

function writeEntry(entry: SessionEntry, sessionKey = key) {
  return sessions.upsertSessionEntryCore({ agentId: "main", sessionKey }, entry);
}

function makeEntry(sessionId: string, fields: Partial<SessionEntry> = {}) {
  return { sessionId, updatedAt: 1, ...fields };
}

function profileActor(client: ReadClient) {
  return {
    type: "human" as const,
    source: "profile" as const,
    id: client.authenticatedUserProfile!.profileId,
  };
}

function expectSubscribed(respond: unknown, sessionKey: string) {
  const payload = { subscribed: true, key: sessionKey, agentId: "main" };
  expect(respond).toHaveBeenCalledExactlyOnceWith(true, payload, undefined);
}

function readParams(method: (typeof methods)[number]) {
  const target = { sessionKey: key, agentId: "main" };
  return method === "sessions.files.assets"
    ? { ...target, path: "note.txt", refs: [] }
    : method === "sessions.files.get"
      ? { ...target, path: "note.txt" }
      : target;
}

function prepareRead(method: (typeof methods)[number], beforeReturn = async () => {}) {
  const afterRead =
    <T>(result: T) =>
    async () => {
      await beforeReturn();
      return result;
    };
  if (method === "sessions.files.assets") {
    return vi
      .spyOn(fileAssets, "getSessionWorkspaceAssets")
      .mockImplementation(afterRead({ assets: [] }));
  }
  if (method === "sessions.files.list") {
    return vi
      .spyOn(workspace, "listSessionWorkspaceFiles")
      .mockImplementation(afterRead({ files: [] }));
  }
  if (method === "sessions.files.get") {
    const name = "note.txt";
    return vi.spyOn(workspace, "getSessionWorkspaceFile").mockImplementation(
      afterRead({
        file: { path: name, name, content: "visible", kind: "read" as const, missing: false },
      }),
    );
  }
  return vi
    .spyOn(sessions, "listSessionBranches")
    .mockImplementation(afterRead({ status: "ok" as const, branches: [] }));
}

it("authorizes original-byte downloads for session-only VIEW readers and revokes HTTP grants with sharing", async () => {
  await withOpenClawTestState(profileState, async (state) => {
    const reader = roleClient("view", "download-reader");
    reader.connId = "narrow-download";
    const controller = new AbortController();
    reader.connectionSignal = controller.signal;
    const owner = roleClient("view", "download-owner");
    using fixture = await prepareReader(reader);
    using _ = { [Symbol.dispose]: () => controller.abort() };
    const bytes = Buffer.alloc(600_001, 0xff);
    await fs.writeFile(path.join(state.workspaceDir, "original.bin"), bytes);
    const entry = makeEntry("download-session", {
      visibility: "shared",
      spawnedCwd: state.workspaceDir,
      permissionMode: "read-only",
      createdActor: profileActor(owner),
    });
    await writeEntry(entry);
    const dispatch = () =>
      fixture.start(
        "sessions.files.download",
        { sessionKey: key, path: "original.bin" },
        { extraHandlers: sessionsFilesHandlers },
      );
    const { respond, request } = dispatch();
    await request;
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    const download = respond.mock.calls[0]?.[1] as { url: string; filename: string };
    expect(download.filename).toBe("original.bin");
    await writeEntry({ ...entry, updatedAt: 2, label: "Renamed while downloading" });
    const fetched = await fetchSessionFileDownload(reader, download.url);
    expect(fetched.response.statusCode).toBe(200);
    expect(Buffer.from(fetched.body as Uint8Array)).toEqual(bytes);
    await writeEntry({ ...entry, visibility: "draft", updatedAt: 3 });
    expect((await fetchSessionFileDownload(reader, download.url)).response.statusCode).toBe(404);
    const denied = dispatch();
    await denied.request;
    expect(denied.respond.mock.calls[0]?.slice(0, 2)).toEqual([false, undefined]);
  });
});

it.each([false, true])(
  "binds describe and message subscriptions to visible rows (roles=%s)",
  async (roles) => {
    await withOpenClawTestState(profileState, async (state) => {
      const reader = roleClient("view", "row-reader");
      const owner = roleClient("view", "row-owner");
      using fixture = await prepareReader(reader, roles ? rolePolicyConfig() : {});
      await state.writeConfig(fixture.cfg);
      const subscribers = createSessionMessageSubscriberRegistry();
      const context = await createHistoryReadContext({
        getRuntimeConfig: () => fixture.cfg,
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
          await writeEntry(
            makeEntry(row.name, {
              visibility: row.visibility,
              ...(row.name === "incognito" ? { incognito: true } : {}),
              createdActor: profileActor(row.own ? reader : owner),
            }),
            sessionKey,
          );
        }
        for (const method of ["sessions.describe", "sessions.messages.subscribe"] as const) {
          if (method === "sessions.describe" && row.name === "own-draft") {
            sessionChanges.emit({ all: true, scope: "config" });
          }
          const client = { ...reader, connId: `${method}-${row.name}` };
          const { respond, request } = fixture.start(
            method,
            { key: sessionKey, agentId: "main" },
            {
              client,
              context,
              extraHandlers: { ...sessionReadHandlers, ...sessionSubscriptionHandlers },
            },
          );
          await request;
          if (method === "sessions.describe") {
            expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
              session: row.visible ? expect.objectContaining({ key: sessionKey }) : null,
            });
          } else if (row.visible) {
            expectSubscribed(respond, sessionKey);
          } else {
            expectRejectedOnce(respond, {
              code: "INVALID_REQUEST",
              message: expect.stringContaining("was not found"),
            });
          }
          expect(subscribers.get(sessionKey).has(client.connId)).toBe(
            method === "sessions.messages.subscribe" && row.visible,
          );
        }
      }
      reader.connect.scopes = ["operator.read"];
      const { respond, request } = fixture.start(
        "sessions.describe",
        { key: "agent:main:read-foreign-draft" },
        { context, extraHandlers: sessionReadHandlers },
      );
      await request;
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
        session: roles ? null : expect.objectContaining({ key: "agent:main:read-foreign-draft" }),
      });
    });
  },
);

it.each(["current", "source", "generation"] as const)(
  "keeps the original %s through message subscription preparation",
  async (change) => {
    await withOpenClawTestState(profileState, async () => {
      const client = {
        ...roleClient("view", "subscription-reader"),
        connId: "subscription-reader",
      };
      using fixture = await prepareReader(client);
      const entry = makeEntry("original", {
        lifecycleRevision: "original",
        visibility: "shared",
      });
      await writeEntry(entry);
      const subscribers = createSessionMessageSubscriberRegistry();
      const context = createDirectChatContext({
        getRuntimeConfig: () => fixture.cfg,
        subscribeSessionMessageEvents: subscribers.subscribe,
      });
      using gate = createRequestGate();
      let current = true;
      const { respond, during, outcome } = fixture.start(
        "sessions.messages.subscribe",
        { key, agentId: "main" },
        {
          context,
          hasCurrentClientAuthority: () => current,
          extraHandlers: createLazyCoreHandlers({
            methods: ["sessions.messages.subscribe"],
            loadHandlers: async () => {
              await gate.pause();
              return sessionSubscriptionHandlers;
            },
          }),
        },
      );
      await during(gate, async () => {
        expect(respond, JSON.stringify(respond.mock.calls)).not.toHaveBeenCalled();
        if (change === "source") {
          current = false;
        }
        if (change === "generation") {
          await writeEntry({
            ...entry,
            lifecycleRevision: "replacement",
            sessionId: "replacement",
          });
        }
      });
      await expectReadSettlement(outcome, respond, change === "source");
      if (change === "current") {
        expectSubscribed(respond, key);
      } else if (change === "generation") {
        expectRejectedOnce(respond, { code: "INVALID_REQUEST" });
      }
      expect(subscribers.get(key).has(client.connId)).toBe(change === "current");
    });
  },
);

it("chat.startup hides foreign draft metadata and rechecks held shared reads", async () => {
  await withOpenClawTestState(profileState, async (state) => {
    const client = roleClient("view", "metadata-reader");
    const owner = roleClient("view", "metadata-owner");
    using fixture = await prepareReader(client);
    await state.writeConfig(fixture.cfg);
    const entry = makeEntry("metadata-session", {
      createdActor: profileActor(owner),
    });
    for (const grant of ["operator.read", "operator.sessions.read"]) {
      client.connect.scopes = [grant];
      for (const visibility of ["draft", "shared", "changed"] as const) {
        await writeEntry({ ...entry, visibility: visibility === "draft" ? "draft" : "shared" });
        using gate = createRequestGate();
        const metadata = { commands: [], models: [], swarmEnabled: false };
        const readMetadata = vi.fn(async () => {
          if (visibility === "changed") {
            await gate.pause();
          }
          return metadata;
        });
        const context = await createHistoryReadContext({
          getRuntimeConfig: () => fixture.cfg,
          readChatStartupProjection: async () => ({
            metadata: await readMetadata(),
            sessionModelCatalog: [],
            defaultModelCatalog: [],
          }),
        });
        const { respond, during, outcome } = fixture.start(
          "chat.startup",
          { agentId: "main", sessionKey: key },
          { context, extraHandlers: chatHistoryHandlers },
        );
        if (visibility === "changed") {
          await during(gate, async () => {
            expect(readMetadata).toHaveBeenCalledOnce();
            await writeEntry({ ...entry, visibility: "draft" });
          });
        }
        await expectReadSettlement(outcome, respond);
        expect(readMetadata).toHaveBeenCalledTimes(visibility === "draft" ? 0 : 1);
        expect(respond.mock.calls[0]?.[0]).toBe(visibility === "shared");
        if (visibility !== "shared") {
          expect(respond.mock.calls[0]?.[1]).toBeUndefined();
        }
      }
    }
  });
});

it("separates a trusted solo operator from its sharing exemption", async () => {
  const method = "sessions.files.get";
  await withOpenClawTestState(profileState, async () => {
    setRuntimeConfigSnapshot({});
    const client = sharingPolicyClient({
      user: GATEWAY_OWNER_PROFILE_ID,
      scopes: ["operator.sessions.read"],
    });
    await writeEntry(
      makeEntry("solo-session", {
        createdActor: { type: "human", source: "profile", id: GATEWAY_OWNER_PROFILE_ID },
      }),
    );
    for (const changed of [false, true]) {
      client.internal = {
        operatorRoleActor: { kind: "operator", profileId: GATEWAY_OWNER_PROFILE_ID },
      };
      using io = prepareRead(method, async () => {
        if (changed) {
          client.internal!.operatorRoleActor = { kind: "operator", profileId: "another-person" };
        }
      });
      const respond = vi.fn();
      await dispatchRequest(method, readParams(method), {
        client,
        context: createDirectChatContext(),
        respond,
        extraHandlers: { ...sessionsFilesHandlers, ...sessionRewindHandlers },
      });
      expect(io).toHaveBeenCalledOnce();
      expect(respond.mock.calls[0]?.[0]).toBe(!changed);
      if (changed) {
        expect(respond.mock.calls[0]?.[1]).toBeUndefined();
      }
    }
  });
});

it.each(methods)("%s retains shared VIEW and hides foreign drafts before I/O", async (method) => {
  await withOpenClawTestState(profileState, async () => {
    const reader = roleClient("view", "scoped-reader");
    const owner = roleClient("view", "scoped-owner");
    const cfg = rolePolicyConfig();
    cfg.gateway!.roles!.definitions.view!.scopes.push("operator.admin");
    using fixture = await prepareReader(reader, cfg);
    const io = prepareRead(method);
    const read = async () => {
      const { respond, request } = fixture.read(method);
      await request;
      return respond;
    };
    const entry = makeEntry("scoped-read", { createdActor: profileActor(owner) });
    for (const visibility of ["draft", "shared"] as const) {
      await writeEntry({ ...entry, visibility });
      io.mockClear();
      const response = await read();
      expect(response.mock.calls[0]?.[0]).toBe(visibility === "shared");
      expect(io).toHaveBeenCalledTimes(visibility === "shared" ? 1 : 0);
    }
    // Broad nonadmin readers use the same visibility owner; adding narrow write cannot bypass it.
    await writeEntry({ ...entry, updatedAt: 2, visibility: "draft" });
    reader.connect.scopes = ["operator.read", "operator.sessions.write"];
    expect((await read()).mock.calls[0]?.[0]).toBe(false);
    reader.connect.scopes = ["operator.admin"];
    expect((await read()).mock.calls[0]?.[0]).toBe(true);
    reader.connect.scopes = ["operator.sessions.read"];
    reader.authenticatedUserProfile = owner.authenticatedUserProfile;
    expect((await read()).mock.calls[0]?.[0]).toBe(true);
  });
});

it.each(methods)("%s retains only current session read facts", async (method) => {
  await withOpenClawTestState(profileState, async (state) => {
    const reader = roleClient("view", "retained-reader");
    using fixture = await prepareReader(reader);
    const metadataChange = { label: "Renamed", updatedAt: 2, lastActivityAt: 2, totalTokens: 10 };
    const changes = [
      ["metadata-no-revision", metadataChange],
      ["metadata", metadataChange],
      ["authority", {}],
      ["generation", { lifecycleRevision: "replacement" }],
      ["visibility", { visibility: "draft" }],
      ["reset", { sessionId: "replacement" }],
      ["archive", { archivedAt: 2 }],
      ["workspace", { spawnedWorkspaceDir: path.join(state.workspaceDir, "replacement") }],
    ] as const;
    const payload =
      method === "sessions.branches.list"
        ? { branches: [] }
        : method === "sessions.files.assets"
          ? { assets: [] }
          : expect.objectContaining({ sessionKey: key });
    for (const [changed, update] of changes) {
      if (
        method === "sessions.branches.list" &&
        ["reset", "archive", "workspace"].includes(changed)
      ) {
        continue;
      }
      const metadataOnly = changed === "metadata-no-revision" || changed === "metadata";
      const entry = makeEntry("original", {
        lifecycleRevision: changed === "metadata-no-revision" ? undefined : "original",
        visibility: "shared",
        archivedAt: undefined,
        spawnedWorkspaceDir: state.workspaceDir,
      });
      await writeEntry(entry);
      if (changed === "metadata-no-revision") {
        expect(
          sessions.loadSessionEntry({ agentId: "main", sessionKey: key })?.lifecycleRevision,
        ).toBeUndefined();
      }
      using gate = createRequestGate();
      using io = prepareRead(method, gate.pause);
      let current = true;
      const { respond, during, outcome } = fixture.read(method, {
        hasCurrentClientAuthority: () => current,
      });
      await during(gate, async () => {
        expect(io).toHaveBeenCalledOnce();
        expect(respond).not.toHaveBeenCalled();
        if (changed === "authority") {
          current = false;
        } else {
          await writeEntry({ ...entry, ...update });
        }
      });
      await expectReadSettlement(outcome, respond, changed === "authority");
      if (changed !== "authority") {
        const response = respond.mock.calls[0];
        const scenario = `${method}/${changed}: ${JSON.stringify(response)}`;
        expect
          .soft(response?.slice(0, 2), scenario)
          .toEqual([metadataOnly, metadataOnly ? payload : undefined]);
      }
    }
  });
});

it("rechecks session visibility before fetching a remote file after stat", async () => {
  await withOpenClawTestState(profileState, async (state) => {
    const reader = roleClient("view", "remote-reader");
    using fixture = await prepareReader(reader);
    for (const revoke of [false, true]) {
      const entry = makeEntry("remote-read", {
        lifecycleRevision: "original",
        visibility: "shared",
        spawnedWorkspaceDir: state.workspaceDir,
      });
      await writeEntry(entry);
      using gate = createRequestGate();
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
              await gate.pause();
            }
            return { type: "file", size: 14, mtimeMs: 1 };
          },
        },
      });
      const { respond, during } = fixture.read("sessions.files.get");
      await during(gate, async () => {
        expect(stats).toBe(2);
        expect(readFile).not.toHaveBeenCalled();
        if (revoke) {
          await writeEntry({ ...entry, visibility: "draft", updatedAt: 2 });
        }
      }).finally(unregister);
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
    using fixture = await prepareReader(client, cfg, identity === "narrow");
    const io = prepareRead(method);
    const { respond, request } = fixture.read(method);
    await request;
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
