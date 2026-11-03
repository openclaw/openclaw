import os from "node:os";
import { expect, vi } from "vitest";
import "../../../test-utils/prepare-compiled-subprocesses.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveLeastPrivilegeOperatorScopesForMethod } from "../../../gateway/method-scopes.js";
import type { SubagentLifecycleHookRunner } from "../../../plugins/hooks.js";
import type { RegisterSubagentRunParams } from "../registry/subagent-registry-run-launch-record.js";
import type {
  RegisterSubagentRunOptions,
  SubagentRegistrationScope,
} from "../registry/subagent-registry.types.js";
import type { SpawnAcpResult } from "./acp-spawn-result.js";

export function expectFailedAcpSpawn(
  result: SpawnAcpResult,
  status?: "error" | "forbidden",
): Extract<SpawnAcpResult, { status: "error" | "forbidden" }> {
  if (status) {
    expect(result.status).toBe(status);
  } else {
    expect(result.status).not.toBe("accepted");
  }
  if (result.status === "accepted") {
    throw new Error("Expected ACP spawn to fail");
  }
  return result;
}

export function expectAcceptedAcpSpawn(
  result: SpawnAcpResult,
): Extract<SpawnAcpResult, { status: "accepted" }> {
  expect(result.status).toBe("accepted");
  if (result.status !== "accepted") {
    throw new Error("Expected ACP spawn to be accepted");
  }
  return result;
}

type MockFn = (...args: unknown[]) => unknown;
type MockImplementationTarget = {
  mockImplementation: (implementation: (opts: { method?: string }) => Promise<unknown>) => unknown;
};
type SessionStore = Record<string, Record<string, unknown>>;
type SessionStoreMutator = (store: SessionStore) => unknown;
type HookRunner = Pick<SubagentLifecycleHookRunner, "hasHooks"> &
  Partial<
    Pick<
      SubagentLifecycleHookRunner,
      "runSubagentSpawned" | "runSubagentProgress" | "runSubagentEnded"
    >
  >;
type SubagentSpawnModuleForTest = Awaited<typeof import("./subagent-spawn.js")> & {
  resetSubagentRegistryForTests: typeof import("../registry/subagent-registry.test-helpers.js").resetSubagentRegistryForTests;
};

type ThinkingProvenanceCase = [
  name: string,
  context: Parameters<typeof import("./subagent-spawn.js").spawnSubagentDirect>[1] & {
    requesterThinkingExplicit?: boolean;
  },
  saved: string | undefined,
  expected: string | undefined,
  spawnThinking?: string,
  requesterThinkingDefault?: string,
];

export function createThinkingProvenanceCases(): ThinkingProvenanceCase[] {
  const automatic: ThinkingProvenanceCase[1] = {
    requesterThinkingLevel: "high",
    requesterThinkingExplicit: false,
  };
  return [
    [
      "inherits explicit active effort",
      { requesterThinkingLevel: "ultra", requesterThinkingExplicit: true },
      "medium",
      "ultra",
    ],
    ["inherits legacy active effort", { requesterThinkingLevel: "ultra" }, "medium", "ultra"],
    ["ignores automatic effort and stale preference", automatic, "medium", undefined],
    ["ignores automatic effort without a preference", automatic, undefined, undefined],
    ["does not persist an unselected model default", {}, undefined, undefined],
    ["prefers explicit spawn effort", automatic, undefined, "low", "low"],
    ["inherits persisted effort", {}, "off", "off"],
    ["inherits configured effort", {}, undefined, "high", undefined, "high"],
  ];
}

export function createSubagentRegistrationScopeForTest(
  overrides: Partial<SubagentRegistrationScope> &
    Pick<SubagentRegistrationScope, "settleFailedLaunch">,
): SubagentRegistrationScope {
  return {
    canLaunch: () => true,
    canAcceptLaunch: () => true,
    canAbortAcceptedRun: () => true,
    canCleanupSession: () => true,
    canRetireReservation: () => true,
    waitForClaim: () => undefined,
    waitForRetirementPublication: () => undefined,
    ...overrides,
  };
}

export function firstMockCall(mock: { mock: { calls: unknown[][] } }, label: string): unknown[] {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`Expected ${label} to be called`);
  }
  return call;
}

export function latestMockCall(mock: { mock: { calls: unknown[][] } }, label: string): unknown[] {
  const call = mock.mock.calls[mock.mock.calls.length - 1];
  if (!call) {
    throw new Error(`Expected ${label} to be called`);
  }
  return call;
}

export function expectRegisteredSubagentRun(
  mock: unknown,
  expected: Partial<RegisterSubagentRunParams>,
  options: Pick<RegisterSubagentRunOptions, "assertCurrent"> = {
    assertCurrent: expect.any(Function),
  },
) {
  expect(mock).toHaveBeenCalledWith(
    expect.objectContaining(expected),
    expect.objectContaining(options),
  );
}

/** Orchestration fixtures assume a supported model; support policy has its own owner tests. */
export async function supportedSpawnModelChoice(
  params: Parameters<typeof import("../../model-runtime-choice.js").prepareModelChoice>[0],
): ReturnType<typeof import("../../model-runtime-choice.js").prepareModelChoice> {
  const { resolveModelRefFromString, buildModelAliasIndex, resolveDefaultModelForAgent } =
    await import("../../model-selection.js");
  const defaults = resolveDefaultModelForAgent({ cfg: params.cfg, agentId: params.agentId });
  const selection = {
    cfg: params.cfg,
    agentId: params.agentId,
    defaultProvider: defaults.provider,
  };
  const selected = params.resolvedRef
    ? { ref: params.resolvedRef }
    : resolveModelRefFromString({
        ...selection,
        raw: params.raw,
        aliasIndex: buildModelAliasIndex(selection),
      });
  if (!selected) {
    throw new Error(`Invalid test model ${params.raw}`);
  }
  return {
    kind: "resolved",
    ref: selected.ref,
    model: {
      id: selected.ref.model,
      name: selected.ref.model,
      provider: selected.ref.provider,
      api: "openai-completions",
      baseUrl: "https://fixture.invalid/v1",
      reasoning: false,
      input: ["text"],
      contextWindow: 4096,
      maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  };
}

export function createSpawnBoundaryConfig(
  workspace: string,
  maxChildrenPerAgent?: number,
): OpenClawConfig {
  return {
    logging: { audit: { enabled: true, executionIdentity: true } },
    tools: { swarm: { enabled: true, maxConcurrent: 1 } },
    agents: {
      ownership: "explicit",
      defaults: {
        workspace,
        systemAgent: { agentId: "main" },
        model: { primary: "custom/test-model" },
        ...(maxChildrenPerAgent !== undefined ? { subagents: { maxChildrenPerAgent } } : {}),
      },
      entries: { main: { workspace } },
    },
    models: {
      mode: "replace",
      providers: {
        custom: {
          api: "openai-completions",
          apiKey: "test-key",
          baseUrl: "https://example.invalid/v1",
          models: [
            {
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              id: "test-model",
              input: ["text"],
              maxTokens: 1_024,
              name: "Test model",
              reasoning: false,
            },
          ],
        },
      },
    },
  };
}

/** Rethrows proof and cleanup failures without losing either outcome. */
export function throwBoundFailures(failures: unknown[]): void {
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "Spawn proof and fixture cleanup failed", {
      cause: failures[0],
    });
  }
}

export function createSubagentSpawnTestConfig(
  workspaceDir = os.tmpdir(),
  overrides?: Record<string, unknown>,
): OpenClawConfig {
  return {
    session: { mainKey: "main", scope: "per-sender" },
    tools: {
      sessions_spawn: {
        attachments: {
          enabled: true,
          maxFiles: 50,
          maxFileBytes: 1 * 1024 * 1024,
          maxTotalBytes: 5 * 1024 * 1024,
        },
      },
    },
    agents: { defaults: { workspace: workspaceDir } },
    ...overrides,
  };
}

export function createConfigOverride(overrides?: Record<string, unknown>) {
  return createSubagentSpawnTestConfig(os.tmpdir(), {
    agents: {
      defaults: { workspace: os.tmpdir() },
      entries: { main: { workspace: "/tmp/workspace-main" } },
    },
    ...overrides,
  });
}

export function setupAcceptedSubagentGatewayMock(callGatewayMock: MockImplementationTarget) {
  callGatewayMock.mockImplementation(async (opts: { method?: string }) => {
    if (opts.method === "sessions.patch" || opts.method === "sessions.delete") {
      return { ok: true };
    }
    if (opts.method === "agent") {
      return { runId: "run-1", status: "accepted", acceptedAt: 1000 };
    }
    return {};
  });
}

async function mutateEmptyStore(_storePath: string, mutator: SessionStoreMutator) {
  const store: SessionStore = {};
  await mutator(store);
  return store;
}

export function installSessionStoreCaptureMock(
  updateSessionStoreMock: {
    mockImplementation: (
      implementation: (storePath: string, mutator: SessionStoreMutator) => Promise<SessionStore>,
    ) => unknown;
  },
  params?: {
    operations?: string[];
    onStore?: (store: SessionStore) => void;
  },
) {
  const store: SessionStore = {};
  updateSessionStoreMock.mockImplementation(
    async (_storePath: string, mutator: SessionStoreMutator) => {
      params?.operations?.push("store:update");
      await mutator(store);
      params?.onStore?.(store);
      return store;
    },
  );
}

export function expectPersistedRuntimeModel(params: {
  persistedStore: SessionStore | undefined;
  sessionKey: string | RegExp;
  provider: string;
  model: string;
  overrideSource?: "auto" | "user";
}) {
  const [persistedKey, persistedEntry] = Object.entries(params.persistedStore ?? {})[0] ?? [];
  if (typeof params.sessionKey === "string") {
    expect(persistedKey).toBe(params.sessionKey);
  } else {
    expect(persistedKey).toMatch(params.sessionKey);
  }
  expect(persistedEntry).toMatchObject({
    modelProvider: params.provider,
    model: params.model,
    providerOverride: params.provider,
    modelOverride: params.model,
    ...(params.overrideSource ? { modelOverrideSource: params.overrideSource } : {}),
  });
}

type SpawnTestConversation = {
  channel: string;
  accountId?: string;
  conversationId: string;
  parentConversationId?: string;
};
type SpawnTestBinding = {
  targetSessionKey: string;
  targetKind?: string;
  status?: string;
  conversation: SpawnTestConversation;
};

/** Load subagent-spawn with runtime dependencies replaced by test doubles. */
export async function loadSubagentSpawnModuleForTest(params: {
  callGatewayMock: MockFn;
  dispatchGatewayMethodInProcessMock?: MockFn;
  hasInProcessGatewayContextMock?: MockFn;
  getRuntimeConfig?: () => Record<string, unknown>;
  loadSessionStoreMock?: MockFn;
  prepareModelChoiceMock?: typeof supportedSpawnModelChoice;
  ensureContextEnginesInitializedMock?: MockFn;
  updateSessionStoreMock?: MockFn;
  forkSessionEntryFromParentMock?: MockFn;
  forkSessionFromParentMock?: MockFn;
  resolveContextEngineMock?: MockFn;
  registerSubagentRunMock?: MockFn;
  startQueuedSubagentRunMock?: MockFn;
  settleFailedQueuedSubagentLaunchMock?: MockFn;
  completeCollectorLaunchCleanupMock?: MockFn;
  emitSessionLifecycleEventMock?: MockFn;
  hookRunner?: HookRunner;
  resolveAgentConfig?: (cfg: Record<string, unknown>, agentId: string) => unknown;
  getSubagentDepthFromSessionStore?: (sessionKey: string, opts?: unknown) => number;
  countActiveRunsForSession?: (sessionKey: string) => number;
  listSwarmRunsForGroup?: (groupId: string) => unknown[];
  resolveSandboxRuntimeStatus?: (params: {
    cfg?: Record<string, unknown>;
    sessionKey?: string;
  }) => { sandboxed: boolean };
  getSessionBindingService?: () => {
    getCapabilities?: (params: { channel?: string; accountId?: string }) => {
      adapterAvailable: boolean;
      bindSupported: boolean;
      placements: Array<"current" | "child">;
    };
    bind?: (
      params: Omit<SpawnTestBinding, "status"> & {
        placement: "current" | "child";
        metadata?: Record<string, unknown>;
      },
    ) => Promise<SpawnTestBinding>;
    listBySession: (
      targetSessionKey: string,
    ) => Array<Pick<SpawnTestBinding, "status" | "conversation">>;
  };
  workspaceDir?: string;
  sessionStorePath?: string;
  resetModules?: boolean;
}): Promise<SubagentSpawnModuleForTest> {
  if (params.resetModules ?? true) {
    // vi.doMock requires a fresh graph unless the fixture explicitly shares mocks.
    vi.resetModules();
  }

  const resetSubagentRegistryForTests = vi.fn(async () => {});

  vi.doMock("../../provider-model-normalization.runtime.js", () => ({
    normalizeProviderModelIdWithRuntime: () => undefined,
  }));

  vi.doMock("./subagent-spawn.runtime.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./subagent-spawn.runtime.js")>()),
    callGateway: (opts: unknown) => params.callGatewayMock(opts),
    dispatchGatewayMethodInProcess: (...args: unknown[]) =>
      params.dispatchGatewayMethodInProcessMock?.(...args),
    hasInProcessGatewayContext: () => Boolean(params.hasInProcessGatewayContextMock?.()),
    forkSessionEntryFromParent:
      params.forkSessionEntryFromParentMock ??
      (async () => {
        const fork = (
          params.forkSessionFromParentMock
            ? await params.forkSessionFromParentMock()
            : { sessionId: "forked-session-id", sessionFile: "/tmp/forked-session.jsonl" }
        ) as { sessionId: string; sessionFile: string } | null;
        if (!fork) {
          return { status: "failed" };
        }
        return {
          status: "forked",
          fork,
          parentEntry: {
            sessionId: "parent-session-id",
            sessionFile: "/tmp/parent-session.jsonl",
            updatedAt: Date.now(),
          },
          sessionEntry: {
            sessionId: fork.sessionId,
            sessionFile: fork.sessionFile,
            forkedFromParent: true,
          },
          decision: {
            status: "fork",
            maxTokens: 100_000,
          },
        };
      }),
    getGlobalHookRunner: () => params.hookRunner ?? { hasHooks: () => false },
    emitSessionLifecycleEvent: (...args: unknown[]) =>
      params.emitSessionLifecycleEventMock?.(...args),
    ADMIN_SCOPE: "operator.admin",
    AGENT_LANE_SUBAGENT: "subagent",
    getRuntimeConfig: () =>
      params.getRuntimeConfig?.() ??
      createSubagentSpawnTestConfig(params.workspaceDir ?? os.tmpdir()),
    prepareModelChoice: params.prepareModelChoiceMock ?? supportedSpawnModelChoice,
    ensureContextEnginesInitialized:
      params.ensureContextEnginesInitializedMock ?? (() => undefined),
    resolveContextEngine: params.resolveContextEngineMock ?? (async () => ({})),
    // Real scope resolver: spawn's admin-tier pinning depends on params-aware
    // sessions.patch policy, so a stub here would hide policy regressions.
    resolveLeastPrivilegeOperatorScopesForMethod,
    upsertSessionEntryCore: async (
      scope: { storePath?: string; sessionKey: string },
      patch: Record<string, unknown>,
    ) => {
      const updateSessionStore = params.updateSessionStoreMock ?? mutateEmptyStore;
      let updated: Record<string, unknown> | undefined;
      const storePath =
        scope.storePath ?? params.sessionStorePath ?? "/tmp/subagent-spawn-model-session.json";
      await updateSessionStore(storePath, (store: SessionStore) => {
        updated = Object.assign({}, store[scope.sessionKey], patch);
        store[scope.sessionKey] = updated;
      });
      return updated ?? null;
    },
    listSessionBindingsBySessionAsync: async (sessionKey: string) =>
      params.getSessionBindingService?.().listBySession(sessionKey) ?? [],
    getSessionBindingService:
      params.getSessionBindingService ??
      (() => ({
        getCapabilities: () => ({
          adapterAvailable: false,
          bindSupported: false,
          placements: [],
        }),
        bind: async () => {
          throw new Error("session binding adapter unavailable");
        },
        listBySession: () => [],
      })),
    mergeDeliveryContext: (
      primary?: Record<string, unknown>,
      fallback?: Record<string, unknown>,
    ) => ({
      ...fallback,
      ...primary,
    }),
    resolveGatewaySessionStoreTargetInWorker: async (targetParams: { key: string }) => ({
      agentId: "main",
      storePath: params.sessionStorePath ?? "/tmp/subagent-spawn-model-session.json",
      canonicalKey: targetParams.key,
      storeKeys: [targetParams.key],
      store: params.loadSessionStoreMock?.(params.sessionStorePath) ?? {},
    }),
    normalizeDeliveryContext: (value: unknown) => value,
    resolveAgentConfig: params.resolveAgentConfig ?? (() => undefined),
    resolveSandboxRuntimeStatus:
      params.resolveSandboxRuntimeStatus ?? (() => ({ sandboxed: false })),
  }));

  // mock-isolation: Spawn fixtures supply caller depth without opening a session database.
  vi.doMock("./subagent-depth.js", () => ({
    getSubagentDepthFromSessionStore: params.getSubagentDepthFromSessionStore ?? (() => 0),
    getSubagentDepthFromSessionStoreInWorker: async (key: string, opts?: unknown) =>
      params.getSubagentDepthFromSessionStore?.(key, opts) ?? 0,
  }));

  vi.doMock("../registry/subagent-registry.js", () => ({
    completeCollectorLaunchCleanup:
      params.completeCollectorLaunchCleanupMock ?? vi.fn(async () => {}),
    countActiveRunsForSession: params.countActiveRunsForSession ?? (() => 0),
    listSwarmRunsForGroup: params.listSwarmRunsForGroup ?? vi.fn(() => []),
    registerSubagentRun: vi.fn(
      async (record: RegisterSubagentRunParams, options?: RegisterSubagentRunOptions) => {
        if (!record.queued || !options?.retainOwnership) {
          await params.registerSubagentRunMock?.(record, options);
          return;
        }
        let retained = false;
        await params.registerSubagentRunMock?.(record, {
          ...options,
          retainOwnership(scope) {
            retained = true;
            options.retainOwnership?.(scope);
          },
        } satisfies RegisterSubagentRunOptions);
        // Successful queued registration transfers custody; stricter test scopes win.
        if (!retained) {
          options.retainOwnership?.(
            createSubagentRegistrationScopeForTest({
              settleFailedLaunch: async (error) => {
                await params.settleFailedQueuedSubagentLaunchMock?.(record.runId, error);
              },
            }),
          );
        }
      },
    ),
    resetSubagentRegistryForTests,
    settleFailedQueuedSubagentLaunch:
      params.settleFailedQueuedSubagentLaunchMock ?? vi.fn(async () => true),
    startQueuedSubagentRun: params.startQueuedSubagentRunMock ?? vi.fn(async () => true),
  }));

  const subagentSpawnModule = await import("./subagent-spawn.js");
  return {
    ...subagentSpawnModule,
    resetSubagentRegistryForTests,
  };
}

export const inheritedSpawnCases = {
  preferences: [
    {
      name: "inherits requester fast mode for collector children",
      task: "inherit fast mode",
      requesterState: { fastMode: "auto" },
      expected: "auto",
      collect: true,
    },
  ],
};
