import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { PreparedModelRuntimePublicationSupersededError } from "../agents/prepared-model-runtime.errors.js";
import * as sessions from "../config/sessions/session-accessor.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createSessionMessageSubscriberRegistry } from "./server-chat-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import { chatHistoryHandlers } from "./server-methods/chat-history-handler.js";
import { createHistoryReadContext } from "./server-methods/chat-history.test-helpers.js";
import { createLazyCoreHandlers } from "./server-methods/lazy-core-handlers.js";
import { sessionsFilesHandlers } from "./server-methods/sessions-files.js";
import { sessionReadHandlers } from "./server-methods/sessions-read.js";
import { sessionRewindHandlers } from "./server-methods/sessions-rewind.js";
import { sessionSubscriptionHandlers } from "./server-methods/sessions-subscriptions.js";
import * as workspace from "./server-methods/workspace-files.js";
import { roleClient, rolePolicyConfig, sharingPolicyClient } from "./session-sharing.test-utils.js";

afterEach(() => vi.restoreAllMocks());

const methods = ["sessions.files.list", "sessions.files.get", "sessions.branches.list"] as const;
const key = "agent:main:scoped-read";

function prepareRead(method: (typeof methods)[number], beforeReturn: () => Promise<void>) {
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
  it.each([false, true])(
    "binds describe and message subscriptions to visible rows (roles=%s)",
    async (roles) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const reader = roleClient("view", "row-reader");
        reader.connect.scopes = ["operator.sessions.read"];
        const owner = roleClient("view", "row-owner");
        const cfg = roles ? rolePolicyConfig() : {};
        await state.writeConfig(cfg);
        const subscribers = createSessionMessageSubscriberRegistry();
        const context = await createHistoryReadContext({
          getRuntimeConfig: () => cfg,
          subscribeSessionMessageEvents: subscribers.subscribe,
        });
        const rows = [
          { name: "own-draft", own: true, visibility: "draft", visible: true },
          { name: "shared", own: false, visibility: "shared", visible: true },
          { name: "foreign-draft", own: false, visibility: "draft", visible: false },
          { name: "incognito", own: true, visibility: "shared", visible: false },
          { name: "missing", own: false, visibility: "shared", visible: false },
        ] as const;
        for (const row of rows) {
          const sessionKey = `agent:main:read-${row.name}`;
          if (row.name !== "missing") {
            await sessions.upsertSessionEntryCore(
              { agentId: "main", sessionKey },
              {
                sessionId: row.name,
                updatedAt: 1,
                visibility: row.visibility,
                ...(row.name === "incognito" ? { incognito: true } : {}),
                createdActor: {
                  type: "human",
                  source: "profile",
                  id: (row.own ? reader : owner).authenticatedUserProfile!.profileId,
                },
              },
            );
          }
          for (const method of ["sessions.describe", "sessions.messages.subscribe"] as const) {
            const client = { ...reader, connId: `${method}-${row.name}` };
            const respond = vi.fn();
            await handleGatewayRequest({
              req: {
                type: "req",
                id: client.connId,
                method,
                params: { key: sessionKey, agentId: "main" },
              },
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
                { subscribed: true, key: sessionKey },
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
          req: {
            type: "req",
            id: "broad-describe",
            method: "sessions.describe",
            params: { key: "agent:main:read-foreign-draft" },
          },
          client: reader,
          context,
          respond,
          isWebchatConnect: () => false,
          extraHandlers: sessionReadHandlers,
        });
        expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
          session: roles ? null : expect.objectContaining({ key: "agent:main:read-foreign-draft" }),
        });
      });
    },
  );

  it.each(["current", "source", "generation"] as const)(
    "keeps the original %s through message subscription preparation",
    async (change) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const client = {
          ...roleClient("view", "subscription-reader"),
          connId: "subscription-reader",
        };
        client.connect.scopes = ["operator.sessions.read"];
        const cfg = rolePolicyConfig();
        const entry = {
          sessionId: "original",
          lifecycleRevision: "original",
          updatedAt: 1,
          visibility: "shared" as const,
        };
        await sessions.upsertSessionEntryCore({ agentId: "main", sessionKey: key }, entry);
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
          req: {
            type: "req",
            id: change,
            method: "sessions.messages.subscribe",
            params: { key, agentId: "main" },
          },
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
            await sessions.upsertSessionEntryCore(
              { agentId: "main", sessionKey: key },
              { ...entry, lifecycleRevision: "replacement", sessionId: "replacement" },
            );
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
              { subscribed: true, key },
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
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const client = roleClient("view", "metadata-reader");
        const owner = roleClient("view", "metadata-owner");
        const cfg = rolePolicyConfig();
        await state.writeConfig(cfg);
        const entry = {
          sessionId: "metadata-session",
          updatedAt: 1,
          createdActor: {
            type: "human" as const,
            source: "profile" as const,
            id: owner.authenticatedUserProfile!.profileId,
          },
        };
        for (const grant of ["operator.read", "operator.sessions.read"]) {
          client.connect.scopes = [grant];
          for (const visibility of ["draft", "shared", "changed"] as const) {
            await sessions.upsertSessionEntryCore(
              { agentId: "main", sessionKey: key },
              {
                ...entry,
                visibility: visibility === "draft" ? "draft" : "shared",
              },
            );
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
              req: {
                type: "req",
                id: `${grant}-${visibility}`,
                method,
                params: { agentId: "main", sessionKey: key },
              },
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
                await sessions.upsertSessionEntryCore(
                  { agentId: "main", sessionKey: key },
                  { ...entry, visibility: "draft" },
                );
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

  it.each(methods)(
    "%s separates a trusted solo operator from its sharing exemption",
    async (method) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const client = sharingPolicyClient({
          user: GATEWAY_OWNER_PROFILE_ID,
          scopes: ["operator.sessions.read"],
        });
        client.internal = {
          operatorRoleActor: { kind: "operator", profileId: GATEWAY_OWNER_PROFILE_ID },
        };
        await sessions.upsertSessionEntryCore(
          { agentId: "main", sessionKey: key },
          {
            sessionId: "solo-session",
            updatedAt: 1,
            createdActor: { type: "human", source: "profile", id: GATEWAY_OWNER_PROFILE_ID },
          },
        );
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
          await handleGatewayRequest({
            req: {
              type: "req",
              id: "solo-narrow",
              method,
              params: {
                sessionKey: key,
                agentId: "main",
                ...(method === "sessions.files.get" ? { path: "note.txt" } : {}),
              },
            },
            client,
            context: createDirectChatContext(),
            respond,
            isWebchatConnect: () => false,
            extraHandlers: { ...sessionsFilesHandlers, ...sessionRewindHandlers },
          });
          expect(io).toHaveBeenCalledOnce();
          expect(respond.mock.calls[0]?.[0]).toBe(!changed);
          if (changed) {
            expect(respond.mock.calls[0]?.[1]).toBeUndefined();
          }
          io.mockRestore();
        }
      });
    },
  );

  it.each(methods)("%s retains shared VIEW and hides foreign drafts before I/O", async (method) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const reader = roleClient("view", "scoped-reader");
      reader.connect.scopes = ["operator.sessions.read"];
      const owner = roleClient("view", "scoped-owner");
      const cfg = rolePolicyConfig();
      cfg.gateway!.roles!.definitions.view!.scopes.push("operator.admin");
      const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
      const io = prepareRead(method, async () => {});
      const request = async () => {
        const respond = vi.fn();
        await handleGatewayRequest({
          req: {
            type: "req",
            id: method,
            method,
            params: {
              sessionKey: key,
              agentId: "main",
              ...(method === "sessions.files.get" ? { path: "note.txt" } : {}),
            },
          },
          client: reader,
          context,
          respond,
          isWebchatConnect: () => false,
          extraHandlers: { ...sessionsFilesHandlers, ...sessionRewindHandlers },
        });
        return respond;
      };
      for (const visibility of ["draft", "shared"] as const) {
        await sessions.upsertSessionEntryCore(
          { agentId: "main", sessionKey: key },
          {
            sessionId: "scoped-read",
            updatedAt: 1,
            visibility,
            createdActor: {
              type: "human",
              source: "profile",
              id: owner.authenticatedUserProfile!.profileId,
            },
          },
        );
        io.mockClear();
        const response = await request();
        expect(response.mock.calls[0]?.[0]).toBe(visibility === "shared");
        expect(io).toHaveBeenCalledTimes(visibility === "shared" ? 1 : 0);
      }
      // Broad nonadmin readers use the same visibility owner; adding narrow write cannot bypass it.
      await sessions.upsertSessionEntryCore(
        { agentId: "main", sessionKey: key },
        {
          sessionId: "scoped-read",
          updatedAt: 2,
          visibility: "draft",
          createdActor: {
            type: "human",
            source: "profile",
            id: owner.authenticatedUserProfile!.profileId,
          },
        },
      );
      reader.connect.scopes = ["operator.read", "operator.sessions.write"];
      expect((await request()).mock.calls[0]?.[0]).toBe(false);
      reader.connect.scopes = ["operator.admin"];
      expect((await request()).mock.calls[0]?.[0]).toBe(true);
      reader.connect.scopes = ["operator.sessions.read"];
      reader.authenticatedUserProfile = owner.authenticatedUserProfile;
      expect((await request()).mock.calls[0]?.[0]).toBe(true);
    });
  });

  it.each(methods)("%s retains only current session read facts", async (method) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const reader = roleClient("view", "retained-reader");
      reader.connect.scopes = ["operator.sessions.read"];
      const cfg = rolePolicyConfig();
      const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
      for (const changed of [
        "metadata-no-revision",
        "metadata",
        "authority",
        "generation",
        "visibility",
      ] as const) {
        const metadataOnly = changed === "metadata-no-revision" || changed === "metadata";
        const entry = {
          sessionId: "original",
          lifecycleRevision: changed === "metadata-no-revision" ? undefined : "original",
          updatedAt: 1,
          visibility: "shared" as const,
        };
        await sessions.upsertSessionEntryCore({ agentId: "main", sessionKey: key }, entry);
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
        const request = handleGatewayRequest({
          req: {
            type: "req",
            id: changed,
            method,
            params: {
              sessionKey: key,
              agentId: "main",
              ...(method === "sessions.files.get" ? { path: "note.txt" } : {}),
            },
          },
          client: reader,
          context,
          respond,
          hasCurrentClientAuthority: () => current,
          isWebchatConnect: () => false,
          extraHandlers: { ...sessionsFilesHandlers, ...sessionRewindHandlers },
        });
        const outcome = Promise.allSettled([request]);
        try {
          await Promise.race([entered.promise, request]);
          expect(io).toHaveBeenCalledOnce();
          expect(respond).not.toHaveBeenCalled();
          if (changed === "authority") {
            current = false;
          } else {
            await sessions.upsertSessionEntryCore(
              { agentId: "main", sessionKey: key },
              {
                ...entry,
                ...(metadataOnly
                  ? { label: "Renamed during read", updatedAt: 2 }
                  : changed === "generation"
                    ? { lifecycleRevision: "replacement" }
                    : { visibility: "draft" }),
              },
            );
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
          const unchangedAccess = method === "sessions.branches.list" && metadataOnly;
          expect(respond.mock.calls[0]?.[0]).toBe(unchangedAccess);
          expect(respond.mock.calls[0]?.[1]).toEqual(
            unchangedAccess ? { branches: [] } : undefined,
          );
        }
      }
    });
  });

  it.each(methods)(
    "%s keeps the missing-row contract without reading a workspace",
    async (method) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const reader = roleClient("view", "missing-reader");
        reader.connect.scopes = ["operator.sessions.read"];
        const io = prepareRead(method, async () => {});
        const respond = vi.fn();
        await handleGatewayRequest({
          req: {
            type: "req",
            id: "missing",
            method,
            params: {
              sessionKey: key,
              agentId: "main",
              ...(method === "sessions.files.get" ? { path: "note.txt" } : {}),
            },
          },
          client: reader,
          context: createDirectChatContext({ getRuntimeConfig: rolePolicyConfig }),
          respond,
          isWebchatConnect: () => false,
          extraHandlers: { ...sessionsFilesHandlers, ...sessionRewindHandlers },
        });
        expect(io).not.toHaveBeenCalled();
        expect(respond.mock.calls[0]?.[0]).toBe(method === "sessions.branches.list");
        expect(respond.mock.calls[0]?.[1]).toEqual(
          method === "sessions.branches.list" ? { branches: [] } : undefined,
        );
      });
    },
  );

  it.each(["sessions.files.list", "sessions.files.get"] as const)(
    "%s preserves canonical solo-owner and internal browsing without a session row",
    async (method) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const io = prepareRead(method, async () => {});
        for (const client of [
          null,
          sharingPolicyClient({ user: GATEWAY_OWNER_PROFILE_ID, scopes: ["operator.read"] }),
        ]) {
          const respond = vi.fn();
          await handleGatewayRequest({
            req: {
              type: "req",
              id: "solo",
              method,
              params: {
                sessionKey: key,
                agentId: "main",
                ...(method === "sessions.files.get" ? { path: "note.txt" } : {}),
              },
            },
            client,
            context: createDirectChatContext(),
            respond,
            isWebchatConnect: () => false,
            extraHandlers: sessionsFilesHandlers,
          });
          expect(respond.mock.calls[0]?.[0]).toBe(true);
        }
        expect(io).toHaveBeenCalledTimes(2);
      });
    },
  );
});
