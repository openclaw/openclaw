import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { PreparedModelRuntimePublicationSupersededError } from "../agents/prepared-model-runtime.errors.js";
import * as sessions from "../config/sessions/session-accessor.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import { chatHistoryHandlers } from "./server-methods/chat-history-handler.js";
import { createHistoryReadContext } from "./server-methods/chat-history.test-helpers.js";
import { sessionsFilesHandlers } from "./server-methods/sessions-files.js";
import { sessionRewindHandlers } from "./server-methods/sessions-rewind.js";
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

  it.each(methods)("%s does not expose data after authority or row replacement", async (method) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const reader = roleClient("view", "retained-reader");
      reader.connect.scopes = ["operator.sessions.read"];
      const cfg = rolePolicyConfig();
      const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
      for (const changed of ["authority", "generation", "visibility"] as const) {
        const entry = {
          sessionId: "original",
          lifecycleRevision: "original",
          updatedAt: 1,
          visibility: "shared" as const,
        };
        await sessions.upsertSessionEntryCore({ agentId: "main", sessionKey: key }, entry);
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
                ...(changed === "generation"
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
          expect(respond.mock.calls[0]?.[0]).toBe(false);
          expect(respond.mock.calls[0]?.[1]).toBeUndefined();
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
