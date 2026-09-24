import { expectDefined, safeParseJsonRecord } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { getPreparedModelRuntimeAuthStore } from "../../agents/prepared-model-runtime-auth.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { hasOpenClawAgentDatabaseAsyncResources } from "../../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  clearUserProfileAuthLink,
  listUserProfileAuthLinks,
  readUserModelAuthProfile,
} from "../../state/user-model-accounts.js";
import { ensureProfileForEmail, setDisplayName } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { bumpGatewayAccessRevision } from "../gateway-access-revision.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import {
  registerGatewayModelCatalogPrivateAccess,
  type PreparedGatewayModelCatalogSnapshot,
} from "../server-model-catalog-auth.js";
import { handleChatMetadataRequest } from "./chat-metadata-handler.js";
import {
  connectChatMetadataAccount,
  createChatMetadataOwner,
  createOpenAIChatMetadataConfig,
} from "./chat-metadata-runtime.test-support.js";
import { WITHOUT_OPENAI_ENV_AUTH } from "./models-list-result.openai-routes.test-support.js";
import { modelsHandlers } from "./models.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "./types.js";

function fixture() {
  const person = ensureProfileForEmail("catalog-reader@example.test");
  setDisplayName(person.id, "Catalog Reader");
  const authProfileId = connectChatMetadataAccount(person.id);
  const config = {
    ...createOpenAIChatMetadataConfig(),
    gateway: {
      roles: {
        default: "reader",
        definitions: {
          reader: { agents: "*", scopes: ["operator.read"], sessions: { others: "none" } },
        },
      },
    },
  } satisfies OpenClawConfig;
  const owner = createChatMetadataOwner(
    config,
    "gpt-5.6-luna",
    {},
    "openai",
    "openai-chatgpt-responses",
  );
  const authStore = expectDefined(getPreparedModelRuntimeAuthStore(owner), "prepared auth store");
  let snapshotCurrent = true;
  const snapshot: PreparedGatewayModelCatalogSnapshot = {
    ...owner.modelCatalog,
    catalogComplete: false,
    agentId: expectDefined(owner.agentId, "fixture agent"),
    agentDir: owner.agentDir,
    workspaceDir: expectDefined(owner.workspaceDir, "fixture workspace"),
    config,
    observationConfig: config,
    metadataSnapshot: owner.metadataSnapshot,
    isCurrent: () => snapshotCurrent && owner.isCurrent(),
    authStore,
    authModes: owner.authModes,
    authMaterializations: [],
  };
  const client: NonNullable<GatewayRequestHandlerOptions["client"]> & { connId: string } = {
    connId: "catalog-reader-connection",
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes: ["operator.read"],
    },
    authenticatedUserProfile: {
      profileId: person.id,
      displayName: person.displayName,
      hasAvatar: false,
      updatedAt: person.updatedAt,
    },
  };
  const clients = new Set([client]);
  const readPrepared = vi.fn(async () => snapshot);
  const loadDeferred = vi.fn(async () => snapshot);
  const loader = async () => snapshot;
  registerGatewayModelCatalogPrivateAccess(loader, { readPrepared, loadDeferred });
  const context = createDirectChatContext({
    getRuntimeConfig: () => config,
    loadGatewayModelCatalogSnapshot: loader,
    getClientConnIds: (filter) =>
      new Set(
        [...clients]
          .filter((current) => !filter || filter(current))
          .map((current) => current.connId),
      ),
  });
  const request = async (
    params: Record<string, unknown>,
    overrides: Partial<Pick<GatewayRequestHandlerOptions, "client" | "signal">> = {},
  ) => {
    const respond = vi.fn<RespondFn>();
    await expectDefined(
      modelsHandlers["models.list"],
      "models.list handler",
    )({
      req: { type: "req", id: "session-catalog", method: "models.list", params },
      params,
      context,
      client,
      respond,
      isWebchatConnect: () => false,
      ...overrides,
    });
    return respond;
  };
  return {
    person,
    authProfileId,
    config,
    client,
    clients,
    snapshot,
    invalidateSnapshot: () => {
      snapshotCurrent = false;
    },
    context,
    readPrepared,
    loadDeferred,
    request,
  };
}

const isolated = {
  layout: "state-only",
  prefix: "direct-session-catalog-",
  env: WITHOUT_OPENAI_ENV_AUTH,
} as const;

describe("direct session model catalogs", () => {
  it.each(["missing", "foreign"] as const)(
    "rejects a saved session with %s ownership before catalog I/O",
    async (ownership) => {
      await withOpenClawTestState(isolated, async (state) => {
        const f = fixture();
        await state.writeConfig(f.config);
        const sessionKey = "agent:main:hidden-catalog";
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: "hidden-catalog-session",
            updatedAt: 1,
            ...(ownership === "foreign"
              ? {
                  createdActor: {
                    type: "human" as const,
                    source: "profile" as const,
                    id: ensureProfileForEmail("hidden-catalog-owner@example.test").id,
                  },
                }
              : {}),
          },
        );
        await expect(f.request({ sessionKey, view: "configured" })).rejects.toThrow(
          `Session "${sessionKey}" was not found.`,
        );
        expect(f.readPrepared).not.toHaveBeenCalled();
        expect(f.loadDeferred).not.toHaveBeenCalled();
        expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
      });
    },
  );

  it("keeps a scoped models.list result across only a committed read acknowledgment", async () => {
    await withOpenClawTestState(isolated, async (state) => {
      const f = fixture();
      await state.writeConfig(f.config);
      const scope = { agentId: "main", sessionKey: "agent:main:catalog-read-marker" };
      await upsertSessionEntryCore(scope, {
        sessionId: "catalog-read-marker-session",
        lifecycleRevision: "catalog-read-marker-lifecycle",
        updatedAt: 1,
        createdActor: { type: "human", source: "profile", id: f.person.id },
        lastReadAt: 1,
        label: "catalog-read-marker-label",
        authProfileOverride: f.authProfileId,
        authProfileOverrideSource: "user",
        toolOverrides: { webSearch: false },
      });
      const before = expectDefined(loadSessionEntry(scope), "saved entry");
      const database = openOpenClawAgentDatabase(scope);
      const readRow = () =>
        expectDefined(
          database.db
            .prepare("SELECT * FROM session_nodes WHERE session_key = ?")
            .get(scope.sessionKey),
          "saved row",
        );
      const beforeRow = readRow();
      const beforePayload = expectDefined(
        safeParseJsonRecord(String(beforeRow.entry_json)),
        "saved payload",
      );
      const params = { sessionKey: scope.sessionKey, view: "configured" };
      const control = await f.request(params);
      expect(control).toHaveBeenCalledExactlyOnceWith(
        true,
        expect.objectContaining({
          models: [expect.objectContaining({ id: "gpt-5.6-luna", available: true })],
        }),
        undefined,
      );
      const entered = createDeferred();
      const release = createDeferred();
      f.readPrepared.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return f.snapshot;
      });
      const pending = f.request(params);
      void pending.catch(() => {});
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("Model catalog completed before the preparation hold");
          }),
        ]);
        await patchSessionEntryCore(scope, () => ({ lastReadAt: 2 }), { preserveActivity: true });
        expect(loadSessionEntry(scope)).toEqual({ ...before, lastReadAt: 2 });
        expect(readRow()).toEqual({
          ...beforeRow,
          entry_json: JSON.stringify({ ...beforePayload, lastReadAt: 2 }),
          last_read_at: 2,
        });
      } finally {
        release.resolve();
        await pending.catch(() => {});
      }
      const changed = await pending;
      const fresh = await f.request(params);
      expect(fresh.mock.calls).toEqual(control.mock.calls);
      expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
      expect(changed.mock.calls).toEqual(control.mock.calls);
    });
  });

  it.each([
    "selected patch",
    "selected reset",
    "store close",
    "access change",
    "catalog owner",
  ] as const)("replies with retryable unavailability after %s", async (change) => {
    await withOpenClawTestState(isolated, async (state) => {
      const f = fixture();
      await state.writeConfig(f.config);
      const scope = { agentId: "main", sessionKey: "agent:main:held-saved" };
      await upsertSessionEntryCore(scope, {
        sessionId: "original",
        updatedAt: 1,
        createdActor: { type: "human", source: "profile", id: f.person.id },
        authProfileOverride: f.authProfileId,
        authProfileOverrideSource: "user",
      });
      const entered = createDeferred();
      const release = createDeferred();
      f.readPrepared.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return f.snapshot;
      });
      const pending = f.request({ sessionKey: scope.sessionKey, view: "configured" });
      void pending.catch(() => {});
      try {
        await Promise.race([entered.promise, pending]);
        expect(f.readPrepared).toHaveBeenCalledOnce();
        if (change === "selected patch") {
          await upsertSessionEntryCore(scope, { label: "changed" });
        } else if (change === "selected reset") {
          await upsertSessionEntryCore(scope, {
            sessionId: "replacement",
            lifecycleRevision: "replacement",
          });
        } else if (change === "store close") {
          closeOpenClawAgentDatabaseByPath(openOpenClawAgentDatabase(scope).path);
        } else if (change === "access change") {
          bumpGatewayAccessRevision();
        } else {
          f.invalidateSnapshot();
        }
      } finally {
        release.resolve();
      }
      const respond = await pending;
      expect(respond).toHaveBeenCalledExactlyOnceWith(
        false,
        undefined,
        expect.objectContaining({
          code: "UNAVAILABLE",
          message: expect.stringMatching(/changed|current/),
          retryable: true,
          retryAfterMs: 0,
        }),
      );
      expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
    });
  });

  it.each([false, true])(
    "revalidates chat.metadata immediately before response (selected changed: %s)",
    async (changeSelected) => {
      await withOpenClawTestState(isolated, async (state) => {
        const f = fixture();
        await state.writeConfig(f.config);
        const selected = { agentId: "main", sessionKey: "agent:main:metadata-selected" };
        const other = { ...selected, sessionKey: "agent:main:metadata-other" };
        await upsertSessionEntryCore(selected, {
          sessionId: "selected",
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: f.person.id },
        });
        await upsertSessionEntryCore(other, {
          sessionId: "other",
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: f.person.id },
        });
        const entered = createDeferred();
        const release = createDeferred();
        f.context.readChatMetadata = async () => {
          entered.resolve();
          await release.promise;
          return { swarmEnabled: false };
        };
        const respond = vi.fn<RespondFn>();
        const params = { sessionKey: selected.sessionKey };
        const pending = handleChatMetadataRequest({
          req: { type: "req", id: "held-metadata", method: "chat.metadata", params },
          params,
          context: f.context,
          client: f.client,
          respond,
          isWebchatConnect: () => false,
        });
        void pending.catch(() => {});
        try {
          await Promise.race([entered.promise, pending]);
          await upsertSessionEntryCore(changeSelected ? selected : other, { label: "changed" });
        } finally {
          release.resolve();
        }
        if (changeSelected) {
          await expect(pending).rejects.toThrow("Session changed");
          expect(respond).not.toHaveBeenCalled();
        } else {
          await pending;
          expect(respond).toHaveBeenCalledWith(true, { swarmEnabled: false });
        }
        expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
      });
    },
  );

  it("uses a saved session pin after the viewer changes their default and keeps agent reads separate", async () => {
    await withOpenClawTestState(isolated, async (state) => {
      const f = fixture();
      f.config.agents = {
        ...f.config.agents,
        list: [
          { id: "main", default: true },
          { id: "other", default: false },
        ],
      };
      await state.writeConfig(f.config);
      const sessionKey = "agent:main:saved";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "saved-catalog-session",
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: f.person.id },
          authProfileOverride: f.authProfileId,
          authProfileOverrideSource: "user",
        },
      );
      clearUserProfileAuthLink({ profileId: f.person.id, provider: "openai" });
      const saved = await f.request({ sessionKey, view: "configured" });
      expect(saved).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          models: [expect.objectContaining({ id: "gpt-5.6-luna", available: true })],
          accountSelection: expect.objectContaining({
            kind: "personal",
            authProfileId: f.authProfileId,
            source: "user",
          }),
        }),
        undefined,
      );
      const neutral = await f.request({ agentId: "main", view: "configured" });
      expect(neutral).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          models: [expect.objectContaining({ available: false })],
          accountSelection: { kind: "automatic", label: "Automatic account selection" },
        }),
        undefined,
      );
      const mismatch = await f.request({ agentId: "other", sessionKey, view: "configured" });
      expect(mismatch).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      expect(f.loadDeferred).not.toHaveBeenCalled();
      expect(f.snapshot.authStore.profiles).toEqual({});
    });
  });

  it("projects a saved native session without borrowing host authentication state", async () => {
    await withOpenClawTestState(isolated, async (state) => {
      const f = fixture();
      await state.writeConfig(f.config);
      clearUserProfileAuthLink({ profileId: f.person.id, provider: "openai" });
      const sessionKey = "agent:main:harness:catalog-native:saved";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "catalog-native-session",
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: f.person.id },
          agentHarnessId: "catalog-native",
          modelSelectionLocked: true,
        },
      );
      const registry = createEmptyPluginRegistry();
      registry.agentHarnesses.push({
        pluginId: "catalog-native",
        source: "test",
        harness: {
          id: "catalog-native",
          label: "Native catalog fixture",
          supports: () => ({ supported: true }),
          runAttempt: async () => {
            throw new Error("A model read must not run inference");
          },
          resolveSessionRuntimeOwnership: (params) => {
            params.assertCurrent();
            return params.sessionKey === sessionKey && params.sessionId === "catalog-native-session"
              ? { model: "native", auth: "native" }
              : undefined;
          },
        },
      });
      setActivePluginRegistry(registry);
      try {
        const direct = await f.request({ sessionKey, view: "configured" });
        expect(direct.mock.calls[0]?.[1]).toMatchObject({
          models: [{ id: "gpt-5.6-luna", provider: "openai" }],
        });
        const payload = direct.mock.calls[0]?.[1];
        expect(payload).not.toEqual(
          expect.objectContaining({
            models: [expect.objectContaining({ available: expect.anything() })],
          }),
        );
        const neutral = await f.request({ agentId: "main", view: "configured" });
        expect(neutral).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ models: [expect.objectContaining({ available: false })] }),
          undefined,
        );
        expect(f.snapshot.entries[0]).not.toHaveProperty("available");
      } finally {
        resetPluginRuntimeStateForTest();
      }
    });
  });

  it("does not substitute a viewer default for a session with no saved pin", async () => {
    await withOpenClawTestState(isolated, async (state) => {
      const f = fixture();
      await state.writeConfig(f.config);
      const agent = await f.request({ agentId: "main", view: "configured" });
      expect(agent).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ models: [expect.objectContaining({ available: true })] }),
        undefined,
      );
      const session = await f.request({ sessionKey: "agent:main:uncreated", view: "configured" });
      expect(session).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ models: [expect.objectContaining({ available: false })] }),
        undefined,
      );
    });
  });

  it("previews a retained self-owned draft without changing shared inventory or account defaults", async () => {
    await withOpenClawTestState(isolated, async () => {
      const f = fixture();
      clearUserProfileAuthLink({ profileId: f.person.id, provider: "openai" });
      const before = readUserModelAuthProfile(f.authProfileId);
      const preview = await f.request({
        agentId: "main",
        authProfileId: f.authProfileId,
        view: "configured",
      });
      expect(preview).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          models: [expect.objectContaining({ available: true })],
          accountSelection: expect.objectContaining({
            kind: "personal",
            authProfileId: f.authProfileId,
            source: "user",
          }),
        }),
        undefined,
      );
      const inventory = await f.request({
        agentId: "main",
        authProfileId: f.authProfileId,
        view: "provider-config",
      });
      expect(inventory.mock.calls[0]?.[1]).not.toHaveProperty("accountSelection");
      expect(listUserProfileAuthLinks(f.person.id)).toEqual([]);
      expect(readUserModelAuthProfile(f.authProfileId)).toEqual(before);
      expect(f.snapshot.authStore.profiles).toEqual({});
      expect(f.loadDeferred).not.toHaveBeenCalled();
    });
  });

  it.each(["foreign admin", "anonymous", "synthetic", "forged locator"] as const)(
    "rejects %s before reading private catalog state",
    async (caller) => {
      await withOpenClawTestState(isolated, async () => {
        const f = fixture();
        let authProfileId = f.authProfileId;
        if (caller === "foreign admin") {
          const other = ensureProfileForEmail("other-reader@example.test");
          f.client.connect.scopes = ["operator.admin"];
          f.client.authenticatedUserProfile = {
            profileId: other.id,
            displayName: other.displayName,
            hasAvatar: false,
            updatedAt: other.updatedAt,
          };
        } else if (caller === "synthetic") {
          f.client.internal = { syntheticClient: true };
        } else if (caller === "forged locator") {
          authProfileId = "personal:missing:missing";
        }
        const result = await f.request(
          { agentId: "main", authProfileId },
          caller === "anonymous" ? { client: null } : {},
        );
        expect(result).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "FORBIDDEN" }),
        );
        expect(f.readPrepared).not.toHaveBeenCalled();
      });
    },
  );

  it("rejects a combined saved-session and draft-account request", async () => {
    await withOpenClawTestState(isolated, async () => {
      const f = fixture();
      const result = await f.request({
        sessionKey: "agent:main:saved",
        authProfileId: f.authProfileId,
      });
      expect(result).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      expect(f.readPrepared).not.toHaveBeenCalled();
    });
  });

  it.each(["disconnect", "role loss", "abort"] as const)(
    "rechecks draft authority after a snapshot await and %s",
    async (loss) => {
      await withOpenClawTestState(isolated, async () => {
        const f = fixture();
        const entered = createDeferred();
        const release = createDeferred();
        const abort = new AbortController();
        f.readPrepared.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return f.snapshot;
        });
        const pending = f.request(
          { agentId: "main", authProfileId: f.authProfileId },
          { signal: abort.signal },
        );
        try {
          await Promise.race([entered.promise, pending]);
          expect(f.readPrepared).toHaveBeenCalledOnce();
          if (loss === "disconnect") {
            f.clients.delete(f.client);
          } else if (loss === "role loss") {
            f.config.gateway.roles.definitions.reader.scopes = [];
          } else {
            abort.abort();
          }
        } finally {
          release.resolve();
        }
        const result = await pending;
        expect(result).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "FORBIDDEN" }),
        );
        expect(f.snapshot.authStore.profiles).toEqual({});
      });
    },
  );
});
