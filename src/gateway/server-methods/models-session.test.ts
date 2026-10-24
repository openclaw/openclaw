import { asNullableRecord, expectDefined, safeParseJsonRecord } from "@openclaw/normalization-core";
import { expect, it as baseIt, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import type { AgentHarnessSessionRuntimeOwnership } from "../../agents/harness/types.js";
import { resolvePublishedModelCatalogOwner } from "../../agents/prepared-model-catalog-owner.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { loadSessionEntry, patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { createFallbackSessionEntry } from "../../config/sessions/session-accessor.sqlite-normalize.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { hasOpenClawAgentDatabaseAsyncResources } from "../../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  clearUserProfileAuthLink,
  listUserProfileAuthLinks,
  readUserModelAuthProfile,
} from "../../state/user-model-accounts.js";
import { publishUserProfileAliasChange } from "../../state/user-profile-events.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { setDisplayName } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  type OpenClawTestState,
  withOpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import {
  registerGatewayModelCatalogPrivateAccess,
  type PreparedGatewayModelCatalogSnapshot,
} from "../server-model-catalog-auth.js";
import { gatewayConnect, gatewayProfile } from "../server/client-fixtures.test-support.js";
import { buildGatewaySessionSnapshot } from "../session-event-payload.js";
import { buildGatewaySessionRow } from "../session-utils-row.js";
import { handleChatMetadataRequest } from "./chat-metadata-handler.js";
import {
  connectChatMetadataAccount,
  createChatMetadataOwner,
  createOpenAIChatMetadataConfig,
} from "./chat-metadata-runtime.test-support.js";
import { WITHOUT_OPENAI_ENV_AUTH } from "./models-list-result.openai-routes.test-support.js";
import { modelsHandlers } from "./models.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "./types.js";

function writeSessionFixture(
  scope: Parameters<typeof patchSessionEntryCore>[0],
  patch: Partial<SessionEntry>,
) {
  openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope)));
  return patchSessionEntryCore(scope, () => patch, {
    skipMaintenance: true,
    fallbackEntry: createFallbackSessionEntry(patch),
  });
}

function fixture(state: OpenClawTestState) {
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
  setRuntimeConfigSnapshot(config);
  const owner = createChatMetadataOwner(
    config,
    "gpt-5.6-luna",
    {},
    "openai",
    "openai-chatgpt-responses",
  );
  let snapshotCurrent = true;
  const snapshot: PreparedGatewayModelCatalogSnapshot = {
    ...resolvePublishedModelCatalogOwner(owner),
    ...owner.modelCatalog,
    catalogComplete: false,
    isCurrent: () => snapshotCurrent && owner.isCurrent(),
    authMaterializations: [],
  };
  const client: NonNullable<GatewayRequestHandlerOptions["client"]> & { connId: string } = {
    connId: "catalog-reader-connection",
    connect: gatewayConnect(["operator.read"]),
    authenticatedUserProfile: gatewayProfile(person.id, person.displayName, person.updatedAt),
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
    overrides: Partial<Pick<GatewayRequestHandlerOptions, "client" | "signal">> & {
      respond?: Reply;
    } = {},
    method: "models.list" | "chat.metadata" = "models.list",
  ) => {
    const respond = overrides.respond ?? vi.fn<RespondFn>();
    const handler =
      method === "chat.metadata" ? handleChatMetadataRequest : modelsHandlers["models.list"]!;
    await handler({
      req: { type: "req", id: "session-catalog", method, params },
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
    state,
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
    saveSession: async (sessionKey: string, patch: Partial<SessionEntry> | "pinned" = {}) => {
      const scope = { agentId: "main", sessionKey };
      await writeSessionFixture(scope, {
        sessionId: sessionKey,
        updatedAt: 1,
        createdActor: { type: "human", source: "profile", id: person.id },
        ...(patch === "pinned"
          ? { authProfileOverride: authProfileId, authProfileOverrideSource: "user" }
          : patch),
      });
      return scope;
    },
  };
}

const isolated = {
  layout: "state-only",
  prepareProfileCatalog: true,
  prefix: "direct-session-catalog-",
  env: WITHOUT_OPENAI_ENV_AUTH,
} as const;

function withFixture(run: (f: ReturnType<typeof fixture>) => Promise<void>) {
  return () =>
    withOpenClawTestState(isolated, async (state) => {
      const f = fixture(state);
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      await run(f);
    });
}

type Fixture = ReturnType<typeof fixture>;
type FixtureBody = (f: Fixture) => Promise<void>;
const it = Object.assign((name: string, run: FixtureBody) => baseIt(name, withFixture(run)), {
  each:
    <T>(rows: readonly T[]) =>
    (name: string, run: (value: T, f: Fixture) => Promise<void>) =>
      baseIt.for(rows)(name, (value) => withFixture((f) => run(value, f))()),
});

async function duringCatalog(
  f: ReturnType<typeof fixture>,
  params: Record<string, unknown>,
  change: () => Promise<void> | void,
  overrides?: Parameters<typeof f.request>[1],
) {
  const entered = createDeferred();
  const release = createDeferred();
  f.readPrepared.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return f.snapshot;
  });
  const pending = f.request(params, overrides);
  void pending.catch(() => {});
  try {
    await awaitGateBeforeSettlement(entered.promise, pending, "Catalog bypassed preparation hold");
    await change();
  } finally {
    release.resolve();
    await pending.catch(() => {});
  }
  return pending;
}

async function closeDatabases(f: ReturnType<typeof fixture>) {
  await closeOpenClawAgentDatabasesAsync(f.state.root);
  expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
}

const personalSelection = (authProfileId: string) =>
  expect.objectContaining({ kind: "personal", authProfileId, source: "user" });

const availableModel = expect.objectContaining({ id: "gpt-5.6-luna", available: true });

type Reply = ReturnType<typeof vi.fn<RespondFn>>;

function expectReply(respond: Reply, result: object, once = false) {
  if (once) {
    expect(respond).toHaveBeenCalledTimes(1);
  }
  expect(respond).toHaveBeenCalledWith(true, expect.objectContaining(result), undefined);
}

function expectError(respond: Reply, error: object, once = false) {
  if (once) {
    expect(respond).toHaveBeenCalledTimes(1);
  }
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining(error));
}

function expectModels(respond: Reply, available: boolean) {
  expectReply(respond, { models: [expect.objectContaining({ available })] });
}

function expectPersonal(respond: Reply, authProfileId: string, once = false) {
  expectReply(
    respond,
    { models: [availableModel], accountSelection: personalSelection(authProfileId) },
    once,
  );
}

it("shares selection revisions with events, ignoring activity", async (f) => {
  await f.state.writeConfig(f.config);
  const scope = await f.saveSession("agent:main:catalog-revision", "pinned");
  let revision: unknown;
  for (const [patch, changed] of [
    [{}, true],
    [{ label: "Renamed", updatedAt: 2, lastReadAt: 2 }, false],
    [{ authProfileOverride: "openai:shared" }, true],
    [{ modelOverride: "gpt-5.6-luna", providerOverride: "openai" }, true],
    [{ agentRuntimeOverride: "openclaw" }, true],
    [{ lifecycleRevision: "replacement" }, true],
  ] satisfies Array<[Partial<SessionEntry>, boolean]>) {
    await writeSessionFixture(scope, patch);
    const respond = await f.request({ sessionKey: scope.sessionKey, view: "configured" });
    const result = respond.mock.calls[0]?.[1];
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(result).toHaveProperty("sessionModelRevision", expect.any(String));
    const nextRevision = (result as { sessionModelRevision: string }).sessionModelRevision;
    expect(nextRevision === revision).toBe(!changed);
    revision = nextRevision;
    const entry = expectDefined(loadSessionEntry(scope), "saved entry");
    const row = buildGatewaySessionRow({
      cfg: f.config,
      agentId: scope.agentId,
      key: scope.sessionKey,
      entry,
      store: { [scope.sessionKey]: entry },
      storePath: openOpenClawAgentDatabase(scope).path,
      preparedAcpMeta: null,
      preparedRepositoryWorkspace: null,
      activeModel: null,
    });
    expect(buildGatewaySessionSnapshot({ sessionRow: row })).toMatchObject({
      session: { sessionModelRevision: revision },
    });
  }
});

it.each(["missing", "foreign"] as const)(
  "rejects %s session ownership before catalog I/O",
  async (ownership, f) => {
    await f.state.writeConfig(f.config);
    const sessionKey = "agent:main:hidden-catalog";
    await writeSessionFixture(
      { agentId: "main", sessionKey },
      {
        sessionId: "hidden-catalog-session",
        updatedAt: 1,
        createdActor:
          ownership === "foreign"
            ? {
                type: "human",
                source: "profile",
                id: ensureProfileForEmail("hidden-catalog-owner@example.test").id,
              }
            : undefined,
      },
    );
    const respond = await f.request({ sessionKey, view: "configured" });
    expect(respond).toHaveBeenCalledExactlyOnceWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: `Session "${sessionKey}" was not found.`,
    });
    expect(f.readPrepared).not.toHaveBeenCalled();
    expect(f.loadDeferred).not.toHaveBeenCalled();
    await closeDatabases(f);
  },
);

it("retains catalog across committed read acknowledgments", async (f) => {
  await f.state.writeConfig(f.config);
  const scope = await f.saveSession("agent:main:catalog-read-marker", {
    sessionId: "catalog-read-marker-session",
    lifecycleRevision: "catalog-read-marker-lifecycle",
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
  expectReply(control, { models: [availableModel] }, true);
  const changed = await duringCatalog(f, params, async () => {
    await patchSessionEntryCore(scope, () => ({ lastReadAt: 2 }), {
      preserveActivity: true,
      skipMaintenance: true,
    });
    expect(loadSessionEntry(scope)).toEqual({ ...before, lastReadAt: 2 });
    expect(readRow()).toEqual({
      ...beforeRow,
      entry_json: JSON.stringify({ ...beforePayload, lastReadAt: 2 }),
      last_read_at: 2,
    });
  });
  const fresh = await f.request(params);
  expect(fresh.mock.calls).toEqual(control.mock.calls);
  expect(changed.mock.calls).toEqual(control.mock.calls);
  await closeDatabases(f);
});

it.each([
  "selected patch",
  "selected reset",
  "store close",
  "same-file reopen",
  "profile alias change",
  "catalog owner",
] as const)("revalidates selected catalog after %s", async (change, f) => {
  await f.state.writeConfig(f.config);
  let closedStorePath: string | undefined;
  const scope = await f.saveSession("agent:main:held-saved", "pinned");
  const respond = await duringCatalog(
    f,
    { sessionKey: scope.sessionKey, view: "configured" },
    async () => {
      expect(f.readPrepared).toHaveBeenCalledOnce();
      if (change === "selected patch") {
        await writeSessionFixture(scope, { label: "changed" });
      } else if (change === "selected reset") {
        await writeSessionFixture(scope, {
          sessionId: "replacement",
          lifecycleRevision: "replacement",
        });
      } else if (change === "store close" || change === "same-file reopen") {
        const database = openOpenClawAgentDatabase(scope);
        if (change === "same-file reopen") {
          await closeOpenClawAgentDatabaseByPathAsync(database.path);
          openOpenClawAgentDatabase(scope);
        } else {
          closeOpenClawAgentDatabaseByPath(database.path);
          closedStorePath = database.path;
        }
      } else if (change === "profile alias change") {
        publishUserProfileAliasChange();
      } else {
        f.invalidateSnapshot();
      }
    },
  );
  if (change === "selected patch") {
    expect(loadSessionEntry(scope)?.label).toBe("changed");
    expectPersonal(respond, f.authProfileId, true);
  } else {
    expectError(
      respond,
      {
        code: "UNAVAILABLE",
        message: expect.stringMatching(/changed|current/),
        retryable: true,
        retryAfterMs: 0,
      },
      true,
    );
    if (closedStorePath) {
      // Synchronous revocation precedes the async resource owner's settlement.
      await closeOpenClawAgentDatabaseByPathAsync(closedStorePath);
    }
  }
  await closeDatabases(f);
});

it.each([false, true])(
  "revalidates chat.metadata when selected model changes (%s)",
  async (changeSelected, f) => {
    await f.state.writeConfig(f.config);
    const selected = await f.saveSession("agent:main:metadata-selected");
    const other = await f.saveSession("agent:main:metadata-other");
    const entered = createDeferred();
    const release = createDeferred();
    f.context.readChatMetadata = async () => {
      entered.resolve();
      await release.promise;
      return { swarmEnabled: false };
    };
    const respond = vi.fn<RespondFn>();
    const pending = f.request({ sessionKey: selected.sessionKey }, { respond }, "chat.metadata");
    void pending.catch(() => {});
    try {
      await Promise.race([entered.promise, pending]);
      await writeSessionFixture(changeSelected ? selected : other, {
        modelOverride: "replacement",
      });
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
    await closeDatabases(f);
  },
);

it("retains session pins independently of viewer defaults", async (f) => {
  f.config.agents = {
    ...f.config.agents,
    ownership: "explicit",
    defaults: {
      ...f.config.agents?.defaults,
      systemAgent: { agentId: "main" },
    },
    entries: { main: {}, other: {} },
  };
  await f.state.writeConfig(f.config);
  const sessionKey = "agent:main:saved";
  await f.saveSession(sessionKey, "pinned");
  clearUserProfileAuthLink({ profileId: f.person.id, provider: "openai" });
  const saved = await f.request({ sessionKey, view: "configured" });
  expectPersonal(saved, f.authProfileId);
  const neutral = await f.request({ agentId: "main", view: "configured" });
  expectReply(neutral, {
    models: [expect.objectContaining({ available: false })],
    accountSelection: { kind: "automatic", label: "Automatic account selection" },
  });
  const mismatch = await f.request({ agentId: "other", sessionKey, view: "configured" });
  expectError(mismatch, { code: "INVALID_REQUEST" });
  expect(f.loadDeferred).not.toHaveBeenCalled();
  expect(f.snapshot.authStore.profiles).toEqual({});
});

it("shares native selection revisions with rows without borrowing host auth", async (f) => {
  await f.state.writeConfig(f.config);
  clearUserProfileAuthLink({ profileId: f.person.id, provider: "openai" });
  const sessionKey = "agent:main:harness:catalog-native:saved";
  const scope = await f.saveSession(sessionKey, {
    sessionId: "catalog-native-session",
    agentHarnessId: "catalog-native",
    modelSelectionLocked: true,
  });
  let ownership: AgentHarnessSessionRuntimeOwnership = { model: "native", auth: "native" };
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
          ? ownership
          : undefined;
      },
    },
  });
  setActivePluginRegistry(registry);
  try {
    const read = async () => {
      const direct = await f.request({ sessionKey, view: "configured" });
      expectReply(direct, {
        models: [expect.objectContaining({ id: "gpt-5.6-luna", provider: "openai" })],
        sessionModelRevision: expect.any(String),
      });
      const payload = direct.mock.calls[0]?.[1];
      const revision = asNullableRecord(payload)?.sessionModelRevision;
      const entry = expectDefined(loadSessionEntry(scope), "saved native entry");
      const row = buildGatewaySessionRow({
        cfg: f.config,
        agentId: scope.agentId,
        key: scope.sessionKey,
        entry,
        store: { [scope.sessionKey]: entry },
        storePath: openOpenClawAgentDatabase(scope).path,
        preparedAcpMeta: null,
        preparedRepositoryWorkspace: null,
        preparedRuntimeOwnership: ownership,
        activeModel: null,
      });
      expect(row.sessionModelRevision).toBe(revision);
      return { revision, payload };
    };
    const initial = await read();
    const { payload } = initial;
    expect(payload).not.toEqual(
      expect.objectContaining({
        models: [expect.objectContaining({ available: expect.anything() })],
      }),
    );
    await writeSessionFixture(scope, {
      label: "Renamed native session",
      updatedAt: 2,
      lastReadAt: 2,
    });
    expect((await read()).revision).toBe(initial.revision);
    const saved = loadSessionEntry(scope);
    let revision = initial.revision;
    for (const next of [
      { model: "native", auth: "host" },
      { model: "native", auth: "native", modelRef: { provider: "openai", model: "gpt-5.6-luna" } },
      { model: "native", auth: "native", modelRef: { provider: "openai", model: "gpt-5.6-sol" } },
    ] satisfies AgentHarnessSessionRuntimeOwnership[]) {
      ownership = next;
      const current = await read();
      expect(current.revision).not.toBe(revision);
      expect((await read()).revision).toBe(current.revision);
      expect(loadSessionEntry(scope)).toEqual(saved);
      revision = current.revision;
    }
    const neutral = await f.request({ agentId: "main", view: "configured" });
    expectModels(neutral, false);
    expect(f.snapshot.entries[0]).not.toHaveProperty("available");
  } finally {
    resetPluginRuntimeStateForTest();
  }
});

it("does not use viewer defaults for unpinned sessions", async (f) => {
  await f.state.writeConfig(f.config);
  const agent = await f.request({ agentId: "main", view: "configured" });
  expectModels(agent, true);
  const session = await f.request({ sessionKey: "agent:main:uncreated", view: "configured" });
  expectModels(session, false);
});

it("previews owned drafts without mutating shared accounts", async (f) => {
  clearUserProfileAuthLink({ profileId: f.person.id, provider: "openai" });
  const before = readUserModelAuthProfile(f.authProfileId);
  const preview = await f.request({
    agentId: "main",
    authProfileId: f.authProfileId,
    view: "configured",
  });
  expectReply(preview, {
    models: [expect.objectContaining({ available: true })],
    accountSelection: personalSelection(f.authProfileId),
  });
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

it.each(["foreign admin", "anonymous", "synthetic", "forged locator"] as const)(
  "rejects %s before private catalog reads",
  async (caller, f) => {
    let authProfileId = f.authProfileId;
    if (caller === "foreign admin") {
      const other = ensureProfileForEmail("other-reader@example.test");
      f.client.connect.scopes = ["operator.admin"];
      f.client.authenticatedUserProfile = gatewayProfile(
        other.id,
        other.displayName,
        other.updatedAt,
      );
    } else if (caller === "synthetic") {
      f.client.internal = { syntheticClient: true };
    } else if (caller === "forged locator") {
      authProfileId = "personal:missing:missing";
    }
    const result = await f.request(
      { agentId: "main", authProfileId },
      caller === "anonymous" ? { client: null } : {},
    );
    expectError(result, { code: "FORBIDDEN" });
    expect(f.readPrepared).not.toHaveBeenCalled();
  },
);

it("rejects combined session and draft selectors", async (f) => {
  const result = await f.request({
    sessionKey: "agent:main:saved",
    authProfileId: f.authProfileId,
  });
  expectError(result, { code: "INVALID_REQUEST" });
  expect(f.readPrepared).not.toHaveBeenCalled();
});

it.each(["disconnect", "role loss", "abort"] as const)(
  "rechecks draft authority after %s",
  async (loss, f) => {
    const abort = new AbortController();
    const result = await duringCatalog(
      f,
      { agentId: "main", authProfileId: f.authProfileId },
      () => {
        expect(f.readPrepared).toHaveBeenCalledOnce();
        if (loss === "disconnect") {
          f.clients.delete(f.client);
        } else if (loss === "role loss") {
          f.config.gateway.roles.definitions.reader.scopes = [];
        } else {
          abort.abort();
        }
      },
      { signal: abort.signal },
    );
    expectError(result, { code: "FORBIDDEN" });
    expect(f.snapshot.authStore.profiles).toEqual({});
  },
);
