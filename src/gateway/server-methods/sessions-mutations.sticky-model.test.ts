import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { clearFollowupQueue, getFollowupQueue } from "../../auto-reply/reply/queue/state.js";
import { setRuntimeConfigSnapshot } from "../../config/io.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { AgentEntryConfig } from "../../config/types.agents.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import * as userModelAccounts from "../../state/user-model-accounts.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const pluginMetadata = vi.hoisted(() => ({
  snapshot: undefined as PluginMetadataSnapshot | undefined,
}));

vi.mock("../../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: () => pluginMetadata.snapshot,
}));

vi.mock("../../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: () => pluginMetadata.snapshot,
  resolvePluginMetadataSnapshot: () => pluginMetadata.snapshot,
}));

vi.mock("../../plugins/provider-thinking.js", () => ({
  resolveEffectiveThinkingProfile: () => undefined,
}));

const runtimeChoice = vi.hoisted(() => ({
  prepare:
    vi.fn<
      typeof import("../../agents/model-runtime-choice.js").preparePublishedModelRuntimeChoice
    >(),
}));
vi.mock("../../agents/model-runtime-choice.js", () => ({
  preparePublishedModelRuntimeChoice: runtimeChoice.prepare,
}));

const effects = vi.hoisted(() => ({
  mutateConfigFileWithRetry: vi.fn(),
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return { ...actual, mutateConfigFileWithRetry: effects.mutateConfigFileWithRetry };
});

import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createGatewaySession } from "../session-create-service.js";
import { TerminalSessionManager } from "../terminal/session-manager.js";
import { flushPendingSessionsChangedEvents } from "./session-change-event.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import { registerSessionNativeRuntimeConsentTests } from "./sessions-mutations.native-consent.test-support.js";
import { registerSessionOperatorPreparationTests } from "./sessions-mutations.operator-preparation.test-support.js";
import { createSessionMutationTestClient } from "./sessions-mutations.owner.test-support.js";
import { registerSessionRuntimeWindowTests } from "./sessions-mutations.runtime-windows.test-support.js";
import { registerSessionSandboxStickyModelTests } from "./sessions-mutations.sandbox.test-support.js";

const defaultAgents: Record<string, AgentEntryConfig> = {
  main: {},
  work: { model: "anthropic/claude-sonnet-4-6" },
};

const defaultConfig = {
  agents: {
    defaults: { model: "anthropic/claude-opus-4-6" },
    entries: defaultAgents,
  },
} satisfies OpenClawConfig;

let cfg: OpenClawConfig;
let persistedConfig: OpenClawConfig | undefined;
let openClawTestState: OpenClawTestState;
let accountOwnerId: string;
let otherPersonId: string;
let personalAuthProfileId: string;
let profileCatalog: Awaited<ReturnType<typeof prepareUserProfileCatalog>> | undefined;

const modelCatalog: ModelCatalogEntry[] = [
  { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus" },
  { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet" },
  { provider: "openai", id: "gpt-5.6-sol", name: "GPT" },
];
type TestClient = GatewayClient & { connId: string; invalidated: boolean };
const sessionScope = (sessionKey: string) => ({ agentId: "main", sessionKey });
const readSession = (key: string) => loadSessionEntry(sessionScope(key));
const seedSession = (key: string, entry: Partial<SessionEntry> = {}, agentId = "main") =>
  upsertSessionEntryCore({ agentId, sessionKey: key }, { sessionId: key, updatedAt: 1, ...entry });
const selectedModel = { providerOverride: "openai", modelOverride: "gpt-5.6-sol" };
const runtimeSelection = { model: "openai/gpt-5.6-sol", agentRuntime: "codex" };
const personalPin = () => ({
  ...selectedModel,
  authProfileOverride: personalAuthProfileId,
  authProfileOverrideSource: "user" as const,
});

function catalogSnapshot(entries = modelCatalog) {
  return {
    entries,
    routeVariants: entries,
    agentId: "main",
    agentDir: openClawTestState.agentDir("main"),
    workspaceDir: openClawTestState.workspaceDir,
    config: cfg,
    catalogComplete: true,
  };
}

function context(clients = new Set<TestClient>()) {
  return {
    ...createDirectChatContext({ getRuntimeConfig: () => cfg }),
    loadGatewayModelCatalogSnapshot: vi.fn<
      GatewayRequestContext["loadGatewayModelCatalogSnapshot"]
    >(async () => catalogSnapshot()),
    broadcastToConnIds: vi.fn<GatewayRequestContext["broadcastToConnIds"]>(),
    getClientConnIds: (filter?: (client: GatewayClient) => boolean) =>
      new Set(
        [...clients]
          .filter((candidate) => !candidate.invalidated && (!filter || filter(candidate)))
          .map((candidate) => candidate.connId),
      ),
  } satisfies GatewayRequestContext;
}

function client(scopes: string[]): TestClient {
  const base = createSessionMutationTestClient();
  base.connect.scopes = scopes;
  return { ...base, connId: "sticky-model-connection", invalidated: false };
}

function personClient(profileId: string, scopes = ["operator.write"]): TestClient {
  return {
    ...client(scopes),
    authenticatedUserProfile: {
      profileId,
      displayName: "Test Person",
      hasAvatar: false,
      updatedAt: 1,
    },
  };
}

async function patchSession(
  params: Record<string, unknown>,
  scopes = ["operator.admin"],
  requestContext: GatewayRequestContext = context(),
  requestClient: GatewayClient = client(scopes),
) {
  const responses: Parameters<RespondFn>[] = [];
  await sessionMutationHandlers["sessions.patch"]?.({
    req: { type: "req", id: "sticky-model-patch", method: "sessions.patch", params },
    params,
    client: requestClient,
    context: requestContext,
    isWebchatConnect: () => true,
    respond: (...response: Parameters<RespondFn>) => responses.push(response),
  });
  expect(responses).toHaveLength(1);
  return responses[0]!;
}

async function personalSession(
  key: string,
  entry: Partial<SessionEntry> = {},
  caller = personClient(accountOwnerId),
) {
  await seedSession(key, entry);
  const before = readSession(key);
  const connections = new Set([caller]);
  const requestContext = context(connections);
  const patch = (params: Record<string, unknown> = {}) =>
    patchSession(
      { key, model: `openai/gpt-5.6-sol@${personalAuthProfileId}`, ...params },
      caller.connect.scopes,
      requestContext,
      caller,
    );
  const expectUnchanged = (response: Parameters<RespondFn>) => {
    expect(response[0]).toBe(false);
    expect(response[2]).toMatchObject({ code: "FORBIDDEN" });
    expect(readSession(key)).toEqual(before);
  };
  return { before, caller, connections, requestContext, patch, expectUnchanged };
}

function runtimeOptions(key: string) {
  return {
    cfg,
    key,
    ...runtimeSelection,
    commandSource: "test",
    operatorRoleActor: { kind: "system" as const },
    loadGatewayModelCatalogSnapshot: async () => catalogSnapshot(),
  };
}

function queueRuntimeSelection(sessionKey: string) {
  const queue = getFollowupQueue(sessionKey, { mode: "followup" });
  const queued = {
    agentId: "main",
    agentDir: "/tmp/agent",
    sessionId: sessionKey,
    sessionKey,
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp/workspace",
    config: cfg,
    provider: "anthropic",
    model: "claude-opus-4-6",
    timeoutMs: 30_000,
    blockReplyBreak: "message_end" as const,
  };
  queue.items.push({ prompt: "Queued work", enqueuedAt: 1, run: queued });
  return queued;
}

beforeAll(async () => {
  openClawTestState = await createOpenClawTestState({ scenario: "minimal" });
  accountOwnerId = ensureProfileForEmail("personal-owner@example.test").id;
  otherPersonId = ensureProfileForEmail("other-person@example.test").id;
  personalAuthProfileId = userModelAccounts.connectUserModelAccount({
    ownerProfileId: accountOwnerId,
    credential: {
      type: "oauth",
      provider: "openai",
      access: "synthetic-personal-access",
      refresh: "synthetic-personal-refresh",
      expires: Date.now() + 60_000,
    },
    assertCurrent: () => {},
  }).authProfileId;
  profileCatalog = await prepareUserProfileCatalog();
  // Persisted runtime pins need installed owners even when a patch changes only permissions.
  pluginMetadata.snapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      { id: "codex", activation: { onAgentHarnesses: ["codex"] } },
      { id: "native-fixture", activation: { onAgentHarnesses: ["claude-cli"] } },
    ],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  cfg = structuredClone(defaultConfig);
  setRuntimeConfigSnapshot(cfg);
  runtimeChoice.prepare.mockReset().mockImplementation(async (input) => ({
    kind: "ready",
    runtimeId: input.runtimeId ?? "openclaw",
    validate: () => undefined,
  }));
  persistedConfig = undefined;
  effects.mutateConfigFileWithRetry
    .mockReset()
    .mockImplementation(
      async (params: { mutate: (draft: OpenClawConfig, context: unknown) => unknown }) => {
        const draft = structuredClone(cfg);
        const result = await params.mutate(draft, {});
        persistedConfig = draft;
        return { nextConfig: draft, result };
      },
    );
});

afterAll(async () => {
  profileCatalog?.release();
  closeOpenClawAgentDatabasesForTest();
  await openClawTestState.cleanup();
});

registerSessionNativeRuntimeConsentTests({
  getConfig: () => cfg,
  catalogSnapshot,
  client,
  context,
  patchSession,
  prepareRuntime: runtimeChoice.prepare,
  configMutationRequested: () => effects.mutateConfigFileWithRetry.mock.calls.length > 0,
  queueRuntimeSelection,
});

registerSessionOperatorPreparationTests({ context, profileId: () => accountOwnerId, personClient });

describe("sessions.patch sticky model persistence", () => {
  registerSessionSandboxStickyModelTests({
    getConfig: () => cfg,
    patchSession,
    configMutationRequested: () => effects.mutateConfigFileWithRetry.mock.calls.length > 0,
    getPersistedConfig: () => persistedConfig,
  });
  it.each([
    { scope: "agent", agentId: "main", model: "anthropic/claude-opus-4-6" },
    { scope: "global", agentId: "work", model: "anthropic/claude-sonnet-4-6" },
  ] as const)(
    "honors configured $scope scope when selecting the current effective model",
    async ({ scope, agentId, model }) => {
      cfg.agents!.defaults!.modelSelectionScope = scope;
      const sessionKey = `agent:${agentId}:dm:scope-current-${scope}`;
      await seedSession(sessionKey, { sessionId: `session-scope-current-${scope}` }, agentId);

      expect((await patchSession({ key: sessionKey, model }))[0]).toBe(true);
      const entry = loadSessionEntry({ agentId, sessionKey });
      expect(entry?.modelOverrideSource).toBe("default");
      expect(entry?.providerOverride).toBeUndefined();
      expect(entry?.modelOverride).toBeUndefined();
      expect(entry?.modelOverrideRouteResolution).toBeUndefined();
      await vi.waitFor(() => expect(persistedConfig).toBeDefined());
      expect(persistedConfig?.agents?.defaults?.model).toBe(
        scope === "global" ? model : defaultConfig.agents.defaults.model,
      );
      const expectedAgents = structuredClone(defaultConfig.agents.entries);
      if (scope === "agent") {
        expectedAgents[agentId]!.model = model;
      }
      expect(persistedConfig?.agents?.entries).toEqual(expectedAgents);
    },
  );

  it("emits a groups invalidation when a patch first registers a category", async () => {
    const sessionKey = "agent:main:dm:category-groups";
    await seedSession(sessionKey, { sessionId: "session-category-groups" });
    const broadcast = vi.fn();
    const subscribedContext = {
      ...context(),
      broadcastToConnIds: broadcast,
      getSessionEventSubscriberConnIds: () => new Set(["conn-groups"]),
    };

    const assignCategory = () =>
      patchSession(
        { key: sessionKey, category: "Fresh Category" },
        ["operator.admin"],
        subscribedContext,
      );
    expect((await assignCategory())[0]).toBe(true);
    const groupsEvents = () =>
      broadcast.mock.calls.filter(
        ([event, payload]) => event === "sessions.changed" && payload.reason === "groups",
      );
    expect(groupsEvents()).toHaveLength(1);

    broadcast.mockClear();
    expect((await assignCategory())[0]).toBe(true);
    expect(groupsEvents()).toHaveLength(0);
  });

  it.each([undefined, "global"] as const)(
    "keeps non-admin model changes session-only with scope=%s",
    async (scope) => {
      cfg.agents!.defaults!.modelSelectionScope = scope;
      const sessionKey = `agent:main:dm:non-admin-${scope ?? "unset"}`;
      await seedSession(sessionKey, { sessionId: `session-non-admin-${scope ?? "unset"}` });

      const response = await patchSession({ key: sessionKey, model: "openai/gpt-5.6-sol" }, [
        "operator.write",
      ]);

      expect(response[0]).toBe(true);
      expect(readSession(sessionKey)).toMatchObject(selectedModel);
      expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
    },
  );

  it.each(["model", "agentRuntime"] as const)(
    "clears the %s pin and invalidates the catalog without changing other pins",
    async (field) => {
      const sessionKey =
        field === "model" ? "agent:main:dm:no-sticky-cleared" : "agent:main:runtime-clear";
      await seedSession(sessionKey, {
        ...selectedModel,
        ...(field === "model"
          ? {
              sessionId: "session-cleared",
              modelOverrideSource: "user",
              modelOverrideRouteResolution: "resolved",
            }
          : {
              agentRuntimeOverride: "openclaw",
              authProfileOverrideSource: "user-link",
              contextTokens: 1000,
              authProfileOverride: personalAuthProfileId,
            }),
      });
      const requestContext = {
        ...context(),
        getSessionEventSubscriberConnIds: () => new Set(["reader"]),
      };
      const response = await patchSession(
        { key: sessionKey, [field]: null },
        ["operator.admin"],
        requestContext,
      );
      await flushPendingSessionsChangedEvents(requestContext);
      expect(response[0]).toBe(true);
      if (field === "model") {
        expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
      } else {
        const stored = readSession(sessionKey);
        expect(stored).toMatchObject({
          modelOverride: "gpt-5.6-sol",
          authProfileOverride: personalAuthProfileId,
          liveModelSwitchPending: true,
        });
        expect(stored).not.toHaveProperty("agentRuntimeOverride");
        expect(stored).not.toHaveProperty("contextTokens");
        expect(runtimeChoice.prepare).not.toHaveBeenCalled();
      }
      expect(requestContext.broadcastToConnIds.mock.calls.at(-1)?.[1]).toMatchObject({
        sessionKey,
        reason: "patch",
        catalogChanged: true,
      });
    },
  );
});

describe("sessions.patch personal model-account ownership", () => {
  it("lets the connected human select a saved personal account for this session", async () => {
    const sessionKey = "agent:main:dm:personal-selection-owner";
    const { patch } = await personalSession(sessionKey, { sessionId: "personal-selection-owner" });
    expect((await patch())[0]).toBe(true);
    expect(readSession(sessionKey)).toMatchObject(personalPin());
    expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
  });

  it.each(["foreign admin", "unidentified admin", "agent"] as const)(
    "denies a new personal selection from a %s before catalog or credential access",
    async (kind) => {
      const sessionKey = `agent:main:dm:personal-selection-denied-${kind.replaceAll(" ", "-")}`;
      const caller =
        kind === "foreign admin"
          ? personClient(otherPersonId, ["operator.admin"])
          : kind === "unidentified admin"
            ? client(["operator.admin"])
            : personClient(accountOwnerId, ["operator.admin"]);
      const { expectUnchanged, requestContext, patch } = await personalSession(
        sessionKey,
        { label: "Original" },
        caller,
      );
      if (kind === "agent") {
        caller.internal = {
          syntheticClient: true,
          agentToolCaller: { agentId: "main", sessionKey },
        };
      }
      const readCredential = vi.spyOn(userModelAccounts, "readUserModelAuthProfile");
      expectUnchanged(await patch({ label: "Must not commit" }));
      expect(requestContext.loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
      expect(readCredential).not.toHaveBeenCalled();
      expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
    },
  );

  it.each(["invalidated", "disconnected", "role revoked"] as const)(
    "rejects a personal selection %s while the model catalog is loading",
    async (loss) => {
      const sessionKey = `agent:main:dm:personal-selection-lost-${loss.replaceAll(" ", "-")}`;
      const { expectUnchanged, caller, connections, requestContext, patch } = await personalSession(
        sessionKey,
        { label: "Before catalog" },
      );
      const writer: GatewayOperatorRoleDefinition = {
        agents: "*",
        scopes: ["operator.write"],
        sessions: { others: "none" },
      };
      cfg.gateway = { roles: { default: "writer", definitions: { writer } } };
      const catalog = createDeferredCore<ReturnType<typeof catalogSnapshot>>();
      const catalogEntered = createDeferredCore();
      requestContext.loadGatewayModelCatalogSnapshot.mockImplementationOnce(() => {
        catalogEntered.resolve();
        return catalog.promise;
      });
      const readCredential = vi.spyOn(userModelAccounts, "readUserModelAuthProfile");
      const pending = patch({ label: "Must not commit" });
      try {
        await awaitGateBeforeSettlement(
          catalogEntered.promise,
          pending,
          `Personal ${loss} patch settled before loading the catalog`,
        );
        expect(requestContext.loadGatewayModelCatalogSnapshot).toHaveBeenCalledOnce();
        if (loss === "invalidated") {
          caller.invalidated = true;
        } else if (loss === "disconnected") {
          connections.delete(caller);
        } else {
          writer.scopes = ["operator.read"];
        }
      } finally {
        catalog.resolve(catalogSnapshot());
      }
      expectUnchanged(await pending);
      expect(readCredential).not.toHaveBeenCalled();
      expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
    },
  );

  it("reports lost personal authority during archive drain as forbidden", async () => {
    const sessionKey = "agent:main:dm:personal-selection-archive-drain";
    const { before, expectUnchanged, caller, connections, requestContext, patch } =
      await personalSession(sessionKey, { sessionId: "personal-selection-archive-drain" });
    const release = vi.fn();
    const terminalSessions = new TerminalSessionManager({ emit: vi.fn() });
    vi.spyOn(terminalSessions, "beginAgentSessionDrain").mockImplementation(() => {
      connections.delete(caller);
      return { drained: Promise.resolve(), hasWork: () => false, release };
    });
    requestContext.terminalSessions = terminalSessions;
    requestContext.chatQueuedTurns = new Map();
    requestContext.dedupe = new Map();
    expectUnchanged(
      await patch({
        archived: true,
        expectedSessionId: before!.sessionId,
      }),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("retains an existing personal pin when an agent patches unrelated session metadata", async () => {
    const sessionKey = "agent:main:dm:personal-selection-inherited";
    await seedSession(sessionKey, {
      sessionId: "personal-selection-inherited",
      ...personalPin(),
      createdActor: { type: "human", id: accountOwnerId, source: "profile" },
    });
    const caller = client(["operator.write"]);
    caller.internal = { syntheticClient: true, agentToolCaller: { agentId: "main", sessionKey } };

    const response = await patchSession(
      { key: sessionKey, label: "Renamed by the session agent" },
      caller.connect.scopes,
      context(),
      caller,
    );

    expect(response[0]).toBe(true);
    expect(readSession(sessionKey)).toMatchObject({
      label: "Renamed by the session agent",
      ...personalPin(),
    });
    expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
  });
});

describe("explicit session model runtimes", () => {
  it.each([
    { model: undefined, agentRuntime: "codex" },
    { model: "gpt-5.6-sol", agentRuntime: "codex" },
    { model: "openai/gpt-5.6-sol", agentRuntime: "default" },
  ])("rejects ambiguous runtime selections without mutating the row (%j)", async (patch) => {
    const sessionKey = "agent:main:runtime-invalid";
    await seedSession(sessionKey, { label: "Original" });
    const response = await patchSession({ key: sessionKey, label: "Wrong", ...patch });
    expect(response[0]).toBe(false);
    expect(readSession(sessionKey)?.label).toBe("Original");
  });

  it("revalidates runtime availability immediately before committing", async () => {
    const sessionKey = "agent:main:runtime-stale";
    await seedSession(sessionKey, { label: "Original" });
    runtimeChoice.prepare.mockResolvedValue({
      kind: "ready",
      runtimeId: "codex",
      validate: vi
        .fn<() => string | undefined>()
        .mockReturnValueOnce(undefined)
        .mockReturnValue("The selected runtime is no longer available."),
    });
    const response = await patchSession({
      key: sessionKey,
      label: "Wrong",
      ...runtimeSelection,
    });
    expect(response[0]).toBe(false);
    expect(response[2]?.message).toContain("no longer available");
    const stored = readSession(sessionKey);
    expect(stored).toMatchObject({ label: "Original" });
    expect(stored).not.toHaveProperty("agentRuntimeOverride");
  });

  it("does not overwrite a replaced session while runtime preparation awaits", async () => {
    const sessionKey = "agent:main:runtime-replaced";
    const entered = createDeferredCore();
    const release = createDeferredCore();
    await seedSession(sessionKey, { sessionId: "original" });
    runtimeChoice.prepare.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return { kind: "ready", runtimeId: "codex", validate: () => undefined };
    });
    const pending = patchSession({
      key: sessionKey,
      expectedSessionId: "original",
      ...runtimeSelection,
    });
    await Promise.race([entered.promise, pending]);
    try {
      expect(runtimeChoice.prepare).toHaveBeenCalledOnce();
      await seedSession(sessionKey, { sessionId: "replacement", updatedAt: 2 });
    } finally {
      release.resolve();
    }
    expect((await pending)[0]).toBe(false);
    const stored = readSession(sessionKey);
    expect(stored).toMatchObject({ sessionId: "replacement" });
    expect(stored).not.toHaveProperty("agentRuntimeOverride");
  });

  it("creates an unlocked session with an explicit runtime and rejects unprivileged adoption changes", async () => {
    const sessionKey = "agent:main:created-runtime";
    const options = runtimeOptions(sessionKey);
    const result = await createGatewaySession(options);
    expect(result).toMatchObject({
      ok: true,
      entry: { agentRuntimeOverride: "codex", modelOverride: "gpt-5.6-sol" },
    });
    expect(result).not.toHaveProperty("entry.modelSelectionLocked");
    expect(result).not.toHaveProperty("entry.liveModelSwitchPending");
    const adopt = (allowExistingModelSelection: boolean) =>
      createGatewaySession({ ...options, agentRuntime: "openclaw", allowExistingModelSelection });
    expect(await adopt(false)).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN", message: "missing scope: operator.admin" },
    });
    expect(readSession(sessionKey)?.agentRuntimeOverride).toBe("codex");
    const queued = queueRuntimeSelection(sessionKey);
    try {
      expect(await adopt(true)).toMatchObject({
        ok: true,
        entry: { agentRuntimeOverride: "openclaw" },
      });
      expect(queued).toMatchObject({
        provider: "openai",
        model: "gpt-5.6-sol",
        requestedRouteResolution: "resolved",
      });
    } finally {
      clearFollowupQueue(sessionKey);
    }
  });

  it("leaves no new session when the published runtime is unavailable", async () => {
    const sessionKey = "agent:main:create-runtime-unavailable";
    runtimeChoice.prepare.mockResolvedValue({
      kind: "unavailable",
      message: "Refresh the model catalog.",
    });
    expect(await createGatewaySession(runtimeOptions(sessionKey))).toMatchObject({
      ok: false,
      error: { message: "Refresh the model catalog." },
    });
    expect(readSession(sessionKey)).toBeUndefined();
  });
});

registerSessionRuntimeWindowTests({
  getConfig: () => cfg,
  getState: () => openClawTestState,
  patchSession: (request, scopes, requestContext) =>
    patchSession(request, scopes, { ...context(), ...requestContext }),
});
