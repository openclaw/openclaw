import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { clearFollowupQueue, getFollowupQueue } from "../../auto-reply/reply/queue/state.js";
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

const modelCatalog: ModelCatalogEntry[] = [
  { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus" },
  { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet" },
  { provider: "openai", id: "gpt-5.6-sol", name: "GPT" },
];
type TestClient = GatewayClient & { connId: string; invalidated: boolean };

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
  return {
    connId: "sticky-model-connection",
    invalidated: false,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes,
    },
  };
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
      await upsertSessionEntryCore(
        { agentId, sessionKey },
        { sessionId: `session-scope-current-${scope}`, updatedAt: 1 },
      );

      expect((await patchSession({ key: sessionKey, model }))[0]).toBe(true);
      expect(loadSessionEntry({ agentId, sessionKey })).toMatchObject({
        providerOverride: "anthropic",
        modelOverride: model.slice("anthropic/".length),
        modelOverrideSource: "user",
        modelOverrideRouteResolution: "resolved",
      });
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
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { sessionId: "session-category-groups", updatedAt: 1 },
    );
    const broadcast = vi.fn();
    const subscribedContext = {
      ...context(),
      broadcastToConnIds: broadcast,
      getSessionEventSubscriberConnIds: () => new Set(["conn-groups"]),
    };

    const first = await patchSession(
      { key: sessionKey, category: "Fresh Category" },
      ["operator.admin"],
      subscribedContext,
    );
    expect(first[0]).toBe(true);
    const groupsEvents = broadcast.mock.calls.filter(
      (call) =>
        call[0] === "sessions.changed" && (call[1] as { reason?: string }).reason === "groups",
    );
    expect(groupsEvents).toHaveLength(1);

    // Re-assigning an already-registered category is not a catalog mutation.
    broadcast.mockClear();
    const second = await patchSession(
      { key: sessionKey, category: "Fresh Category" },
      ["operator.admin"],
      subscribedContext,
    );
    expect(second[0]).toBe(true);
    expect(
      broadcast.mock.calls.filter(
        (call) =>
          call[0] === "sessions.changed" && (call[1] as { reason?: string }).reason === "groups",
      ),
    ).toHaveLength(0);
  });

  it.each([undefined, "global"] as const)(
    "keeps non-admin model changes session-only with scope=%s",
    async (scope) => {
      cfg.agents!.defaults!.modelSelectionScope = scope;
      const sessionKey = `agent:main:dm:non-admin-${scope ?? "unset"}`;
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        { sessionId: `session-non-admin-${scope ?? "unset"}`, updatedAt: 1 },
      );

      const response = await patchSession({ key: sessionKey, model: "openai/gpt-5.6-sol" }, [
        "operator.write",
      ]);

      expect(response[0]).toBe(true);
      expect(loadSessionEntry({ agentId: "main", sessionKey })).toMatchObject({
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
      });
      expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
    },
  );

  it("does not persist when model is cleared", async () => {
    const sessionKey = "agent:main:dm:no-sticky-cleared";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        sessionId: "session-cleared",
        updatedAt: 1,
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
        modelOverrideSource: "user",
        modelOverrideRouteResolution: "resolved",
      },
    );
    const requestContext = {
      ...context(),
      getSessionEventSubscriberConnIds: () => new Set(["reader"]),
    };
    const response = await patchSession(
      { key: sessionKey, model: null },
      ["operator.admin"],
      requestContext,
    );
    await flushPendingSessionsChangedEvents(requestContext);
    expect(response[0]).toBe(true);
    expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
    expect(requestContext.broadcastToConnIds.mock.calls.at(-1)?.[1]).toMatchObject({
      sessionKey,
      reason: "patch",
      catalogChanged: true,
    });
  });
});

describe("sessions.patch personal model-account ownership", () => {
  it("lets the connected human select a saved personal account for this session", async () => {
    const sessionKey = "agent:main:dm:personal-selection-owner";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { sessionId: "personal-selection-owner", updatedAt: 1 },
    );
    const caller = personClient(accountOwnerId);
    const requestContext = context(new Set([caller]));

    const response = await patchSession(
      { key: sessionKey, model: `openai/gpt-5.6-sol@${personalAuthProfileId}` },
      caller.connect.scopes,
      requestContext,
      caller,
    );

    expect(response[0]).toBe(true);
    expect(loadSessionEntry({ agentId: "main", sessionKey })).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-5.6-sol",
      authProfileOverride: personalAuthProfileId,
      authProfileOverrideSource: "user",
    });
    expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
  });

  it.each(["foreign admin", "unidentified admin", "agent"] as const)(
    "denies a new personal selection from a %s before catalog or credential access",
    async (kind) => {
      const sessionKey = `agent:main:dm:personal-selection-denied-${kind.replaceAll(" ", "-")}`;
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        { sessionId: sessionKey, updatedAt: 1, label: "Original" },
      );
      const before = loadSessionEntry({ agentId: "main", sessionKey });
      const caller =
        kind === "foreign admin"
          ? personClient(otherPersonId, ["operator.admin"])
          : kind === "unidentified admin"
            ? client(["operator.admin"])
            : personClient(accountOwnerId, ["operator.admin"]);
      if (kind === "agent") {
        caller.internal = {
          syntheticClient: true,
          agentToolCaller: { agentId: "main", sessionKey },
        };
      }
      const requestContext = context(new Set([caller]));
      const readCredential = vi.spyOn(userModelAccounts, "readUserModelAuthProfile");

      const response = await patchSession(
        {
          key: sessionKey,
          model: `openai/gpt-5.6-sol@${personalAuthProfileId}`,
          label: "Must not commit",
        },
        caller.connect.scopes,
        requestContext,
        caller,
      );

      expect(response[0]).toBe(false);
      expect(response[2]).toMatchObject({ code: "FORBIDDEN" });
      expect(requestContext.loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
      expect(readCredential).not.toHaveBeenCalled();
      expect(loadSessionEntry({ agentId: "main", sessionKey })).toEqual(before);
      expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
    },
  );

  it.each(["invalidated", "disconnected", "role revoked"] as const)(
    "rejects a personal selection %s while the model catalog is loading",
    async (loss) => {
      const sessionKey = `agent:main:dm:personal-selection-lost-${loss.replaceAll(" ", "-")}`;
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        { sessionId: sessionKey, updatedAt: 1, label: "Before catalog" },
      );
      const before = loadSessionEntry({ agentId: "main", sessionKey });
      const writer: GatewayOperatorRoleDefinition = {
        agents: "*",
        scopes: ["operator.write"],
        sessions: { others: "none" },
      };
      cfg.gateway = { roles: { default: "writer", definitions: { writer } } };
      const caller = personClient(accountOwnerId);
      const connections = new Set([caller]);
      const requestContext = context(connections);
      const catalog = createDeferredCore<ReturnType<typeof catalogSnapshot>>();
      requestContext.loadGatewayModelCatalogSnapshot.mockReturnValueOnce(catalog.promise);
      const readCredential = vi.spyOn(userModelAccounts, "readUserModelAuthProfile");
      const pending = patchSession(
        {
          key: sessionKey,
          model: `openai/gpt-5.6-sol@${personalAuthProfileId}`,
          label: "Must not commit",
        },
        caller.connect.scopes,
        requestContext,
        caller,
      );
      try {
        await vi.waitFor(() =>
          expect(requestContext.loadGatewayModelCatalogSnapshot).toHaveBeenCalledOnce(),
        );
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
      const response = await pending;

      expect(response[0]).toBe(false);
      expect(response[2]).toMatchObject({ code: "FORBIDDEN" });
      expect(readCredential).not.toHaveBeenCalled();
      expect(loadSessionEntry({ agentId: "main", sessionKey })).toEqual(before);
      expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
    },
  );

  it("reports lost personal authority during archive drain as forbidden", async () => {
    const sessionKey = "agent:main:dm:personal-selection-archive-drain";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { sessionId: "personal-selection-archive-drain", updatedAt: 1 },
    );
    const before = loadSessionEntry({ agentId: "main", sessionKey });
    const caller = personClient(accountOwnerId);
    const connections = new Set([caller]);
    const release = vi.fn();
    const terminalSessions = new TerminalSessionManager({ emit: vi.fn() });
    vi.spyOn(terminalSessions, "beginAgentSessionDrain").mockImplementation(() => {
      connections.delete(caller);
      return { drained: Promise.resolve(), hasWork: () => false, release };
    });
    const requestContext = {
      ...context(connections),
      terminalSessions,
      chatQueuedTurns: new Map(),
      dedupe: new Map(),
    };
    const response = await patchSession(
      {
        key: sessionKey,
        model: `openai/gpt-5.6-sol@${personalAuthProfileId}`,
        archived: true,
        expectedSessionId: before!.sessionId,
      },
      caller.connect.scopes,
      requestContext,
      caller,
    );

    expect(response[0]).toBe(false);
    expect(response[2]).toMatchObject({ code: "FORBIDDEN" });
    expect(loadSessionEntry({ agentId: "main", sessionKey })).toEqual(before);
    expect(release).toHaveBeenCalledOnce();
  });

  it("retains an existing personal pin when an agent patches unrelated session metadata", async () => {
    const sessionKey = "agent:main:dm:personal-selection-inherited";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        sessionId: "personal-selection-inherited",
        updatedAt: 1,
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
        authProfileOverride: personalAuthProfileId,
        authProfileOverrideSource: "user",
        createdActor: { type: "human", id: accountOwnerId, source: "profile" },
      },
    );
    const caller = client(["operator.write"]);
    caller.internal = { syntheticClient: true, agentToolCaller: { agentId: "main", sessionKey } };

    const response = await patchSession(
      { key: sessionKey, label: "Renamed by the session agent" },
      caller.connect.scopes,
      context(),
      caller,
    );

    expect(response[0]).toBe(true);
    expect(loadSessionEntry({ agentId: "main", sessionKey })).toMatchObject({
      label: "Renamed by the session agent",
      authProfileOverride: personalAuthProfileId,
      authProfileOverrideSource: "user",
      providerOverride: "openai",
      modelOverride: "gpt-5.6-sol",
    });
    expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
  });
});

describe("explicit session model runtimes", () => {
  it("clears only the runtime pin and preserves the explicit model and account", async () => {
    const sessionKey = "agent:main:runtime-clear";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        sessionId: sessionKey,
        updatedAt: 1,
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
        agentRuntimeOverride: "openclaw",
        authProfileOverride: personalAuthProfileId,
        authProfileOverrideSource: "user-link",
        contextTokens: 1000,
      },
    );
    const requestContext = {
      ...context(),
      getSessionEventSubscriberConnIds: () => new Set(["reader"]),
    };
    const response = await patchSession(
      { key: sessionKey, agentRuntime: null },
      ["operator.admin"],
      requestContext,
    );
    expect(response[0]).toBe(true);
    await flushPendingSessionsChangedEvents(requestContext);
    expect(requestContext.broadcastToConnIds.mock.calls.at(-1)?.[1]).toMatchObject({
      sessionKey,
      reason: "patch",
      catalogChanged: true,
    });
    const stored = loadSessionEntry({ agentId: "main", sessionKey });
    expect(stored).toMatchObject({
      modelOverride: "gpt-5.6-sol",
      authProfileOverride: personalAuthProfileId,
      liveModelSwitchPending: true,
    });
    expect(stored).not.toHaveProperty("agentRuntimeOverride");
    expect(stored).not.toHaveProperty("contextTokens");
    expect(runtimeChoice.prepare).not.toHaveBeenCalled();
  });

  it.each([
    { model: undefined, agentRuntime: "codex" },
    { model: "gpt-5.6-sol", agentRuntime: "codex" },
    { model: "openai/gpt-5.6-sol", agentRuntime: "default" },
  ])("rejects ambiguous runtime selections without mutating the row (%j)", async (patch) => {
    const sessionKey = "agent:main:runtime-invalid";
    const entry = { sessionId: sessionKey, updatedAt: 1, label: "Original" };
    await upsertSessionEntryCore({ agentId: "main", sessionKey }, entry);
    const response = await patchSession({ key: sessionKey, label: "Wrong", ...patch });
    expect(response[0]).toBe(false);
    expect(loadSessionEntry({ agentId: "main", sessionKey })?.label).toBe("Original");
  });

  it("revalidates runtime availability immediately before committing", async () => {
    const sessionKey = "agent:main:runtime-stale";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { sessionId: sessionKey, updatedAt: 1, label: "Original" },
    );
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
      model: "openai/gpt-5.6-sol",
      agentRuntime: "codex",
    });
    expect(response[0]).toBe(false);
    expect(response[2]?.message).toContain("no longer available");
    const stored = loadSessionEntry({ agentId: "main", sessionKey });
    expect(stored).toMatchObject({ label: "Original" });
    expect(stored).not.toHaveProperty("agentRuntimeOverride");
  });

  it("does not overwrite a replaced session while runtime preparation awaits", async () => {
    const sessionKey = "agent:main:runtime-replaced";
    const entered = createDeferredCore();
    const release = createDeferredCore();
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { sessionId: "original", updatedAt: 1 },
    );
    runtimeChoice.prepare.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return { kind: "ready", runtimeId: "codex", validate: () => undefined };
    });
    const pending = patchSession({
      key: sessionKey,
      expectedSessionId: "original",
      model: "openai/gpt-5.6-sol",
      agentRuntime: "codex",
    });
    await Promise.race([entered.promise, pending]);
    try {
      expect(runtimeChoice.prepare).toHaveBeenCalledOnce();
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        { sessionId: "replacement", updatedAt: 2 },
      );
    } finally {
      release.resolve();
    }
    expect((await pending)[0]).toBe(false);
    const stored = loadSessionEntry({ agentId: "main", sessionKey });
    expect(stored).toMatchObject({ sessionId: "replacement" });
    expect(stored).not.toHaveProperty("agentRuntimeOverride");
  });

  it("creates an unlocked session with an explicit runtime and rejects unprivileged adoption changes", async () => {
    const sessionKey = "agent:main:created-runtime";
    const options = {
      cfg,
      key: sessionKey,
      model: "openai/gpt-5.6-sol",
      agentRuntime: "codex",
      commandSource: "test",
      operatorRoleActor: { kind: "system" as const },
      loadGatewayModelCatalogSnapshot: async () => catalogSnapshot(),
    };
    const result = await createGatewaySession(options);
    expect(result).toMatchObject({
      ok: true,
      entry: {
        agentRuntimeOverride: "codex",
        modelOverride: "gpt-5.6-sol",
      },
    });
    expect(result).not.toHaveProperty("entry.modelSelectionLocked");
    expect(result).not.toHaveProperty("entry.liveModelSwitchPending");
    expect(
      await createGatewaySession({
        ...options,
        agentRuntime: "openclaw",
        allowExistingModelSelection: false,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN", message: "missing scope: operator.admin" },
    });
    expect(loadSessionEntry({ agentId: "main", sessionKey })?.agentRuntimeOverride).toBe("codex");
    const queued = queueRuntimeSelection(sessionKey);
    try {
      expect(
        await createGatewaySession({
          ...options,
          agentRuntime: "openclaw",
          allowExistingModelSelection: true,
        }),
      ).toMatchObject({ ok: true, entry: { agentRuntimeOverride: "openclaw" } });
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
    expect(
      await createGatewaySession({
        cfg,
        key: sessionKey,
        model: "openai/gpt-5.6-sol",
        agentRuntime: "codex",
        commandSource: "test",
        operatorRoleActor: { kind: "system" },
        loadGatewayModelCatalogSnapshot: async () => catalogSnapshot(),
      }),
    ).toMatchObject({ ok: false, error: { message: "Refresh the model catalog." } });
    expect(loadSessionEntry({ agentId: "main", sessionKey })).toBeUndefined();
  });
});

registerSessionRuntimeWindowTests({
  getConfig: () => cfg,
  getState: () => openClawTestState,
  patchSession: (request, scopes, requestContext) =>
    patchSession(request, scopes, { ...context(), ...requestContext }),
});
