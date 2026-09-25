// Subagent spawn test helpers install mocked runtime seams so sessions_spawn
// tests can exercise orchestration without real gateway/session-store effects.
import os from "node:os";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { expect, vi } from "vitest";
import type { ThinkLevel } from "../../../auto-reply/thinking.shared.js";
import type { applySessionEntryCanonicalReplacements } from "../../../config/sessions/session-accessor.sqlite-replacement-projection.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { resolveLeastPrivilegeOperatorScopesForMethod } from "../../../gateway/method-scopes.js";
import type { SubagentLifecycleHookRunner } from "../../../plugins/hooks.js";
import type { InheritedToolPolicySourceCapture } from "../../inherited-tool-policy.schema.js";
import { captureGatewayToolCallerAssertion } from "../../tools/gateway-caller-context.js";
import type { RegisterSubagentRunParams } from "../registry/subagent-registry-run-launch-record.js";
import type { RegisterSubagentRunOptions } from "../registry/subagent-registry.types.js";
import type {
  SpawnSubagentContext,
  SpawnSubagentParams,
  SpawnSubagentResult,
} from "./subagent-spawn-contract.js";

export const captureTestSpawnToolPolicy: InheritedToolPolicySourceCapture = async () => ({
  policy: { clauses: [], parameters: { fileTools: [], exec: [], sandbox: [], unsupported: [] } },
  assertCurrent: () => {},
});

export const captureAdmittedTestSpawnToolPolicy: InheritedToolPolicySourceCapture = async () => {
  const assertCurrent = captureGatewayToolCallerAssertion();
  if (!assertCurrent) {
    throw new Error("Delegation fixture requires an admitted source");
  }
  assertCurrent();
  const { policy } = await captureTestSpawnToolPolicy();
  assertCurrent();
  return { policy, assertCurrent };
};

export type SpawnSubagentForTest = (
  params: SpawnSubagentParams,
  context: Omit<SpawnSubagentContext, "captureInheritedToolPolicyForDelegation"> & {
    captureInheritedToolPolicyForDelegation?: InheritedToolPolicySourceCapture;
  },
) => Promise<SpawnSubagentResult>;

export function withTestSpawnPolicy(
  spawn: typeof import("./subagent-spawn.js").spawnSubagentDirect,
): SpawnSubagentForTest {
  return (params, context) =>
    spawn(
      params,
      Object.assign(context, {
        captureInheritedToolPolicyForDelegation:
          context.captureInheritedToolPolicyForDelegation ?? captureTestSpawnToolPolicy,
      }),
    );
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
type SubagentSpawnModuleForTest = Omit<
  Awaited<typeof import("./subagent-spawn.js")>,
  "spawnSubagentDirect"
> & {
  spawnSubagentDirect: SpawnSubagentForTest;
  resetSubagentRegistryForTests: MockFn;
};

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

/** Build a minimal runtime config for sessions_spawn tests. */
export function createSubagentSpawnTestConfig(
  workspaceDir = os.tmpdir(),
  overrides?: Record<string, unknown>,
) {
  return {
    session: {
      mainKey: "main",
      scope: "per-sender",
    },
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
    agents: {
      defaults: {
        workspace: workspaceDir,
      },
    },
    ...overrides,
  };
}

export function createConfigOverride(overrides?: Record<string, unknown>) {
  return createSubagentSpawnTestConfig(os.tmpdir(), {
    agents: {
      defaults: {
        workspace: os.tmpdir(),
      },
      list: [
        {
          id: "main",
          workspace: "/tmp/workspace-main",
        },
      ],
    },
    ...overrides,
  });
}

/** Mock gateway calls for the common accepted-spawn flow. */
export function setupAcceptedSubagentGatewayMock(callGatewayMock: MockImplementationTarget) {
  callGatewayMock.mockImplementation(async (opts: { method?: string }) => {
    if (opts.method === "sessions.patch") {
      return { ok: true };
    }
    if (opts.method === "sessions.delete") {
      return { ok: true };
    }
    if (opts.method === "agent") {
      return { runId: "run-1", status: "accepted", acceptedAt: 1000 };
    }
    return {};
  });
}

function identityDeliveryContext(value: unknown) {
  return value;
}

function createDefaultSessionHelperMocks() {
  return {
    resolveMainSessionAlias: () => ({ mainKey: "main", alias: "main" }),
    resolveInternalSessionKey: ({ key }: { key?: string }) => key ?? "agent:main:main",
    resolveDisplaySessionKey: ({ key }: { key?: string }) => key ?? "agent:main:main",
  };
}

/** Install an updateSessionStore mock that captures mutations in memory. */
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

/** Assert the persisted session entry captured the expected runtime model. */
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
  expect(persistedEntry?.modelProvider).toBe(params.provider);
  expect(persistedEntry?.model).toBe(params.model);
  expect(persistedEntry?.providerOverride).toBe(params.provider);
  expect(persistedEntry?.modelOverride).toBe(params.model);
  if (params.overrideSource) {
    expect(persistedEntry?.modelOverrideSource).toBe(params.overrideSource);
  }
}

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
  resolveParentForkDecisionMock?: MockFn;
  registerSubagentRunMock?: MockFn;
  startQueuedSubagentRunMock?: MockFn;
  settleFailedQueuedSubagentLaunchMock?: MockFn;
  completeCollectorLaunchCleanupMock?: MockFn;
  emitSessionLifecycleEventMock?: MockFn;
  hookRunner?: HookRunner;
  resolveAgentConfig?: (cfg: Record<string, unknown>, agentId: string) => unknown;
  resolveAgentWorkspaceDir?: (cfg: Record<string, unknown>, agentId: string) => string;
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
    bind?: (params: {
      targetSessionKey: string;
      targetKind?: string;
      conversation: {
        channel: string;
        accountId?: string;
        conversationId: string;
        parentConversationId?: string;
      };
      placement: "current" | "child";
      metadata?: Record<string, unknown>;
    }) => Promise<{
      targetSessionKey: string;
      targetKind?: string;
      status?: string;
      conversation: {
        channel: string;
        accountId?: string;
        conversationId: string;
        parentConversationId?: string;
      };
    }>;
    listBySession: (targetSessionKey: string) => Array<{
      status?: string;
      conversation: {
        channel: string;
        accountId?: string;
        conversationId: string;
        parentConversationId?: string;
      };
    }>;
  };
  resolveConversationDeliveryTarget?: (params: {
    channel?: string;
    conversationId?: string | number;
    parentConversationId?: string | number;
  }) => { to?: string; threadId?: string };
  workspaceDir?: string;
  sessionStorePath?: string;
  resetModules?: boolean;
}): Promise<SubagentSpawnModuleForTest> {
  if (params.resetModules ?? true) {
    // The helper rewires imports with vi.doMock, so each test starts from a
    // fresh module graph unless explicitly sharing mocks.
    vi.resetModules();
  }

  const resetSubagentRegistryForTests = vi.fn();

  vi.doMock("../../provider-model-normalization.runtime.js", () => ({
    normalizeProviderModelIdWithRuntime: () => undefined,
  }));

  vi.doMock("./subagent-spawn.runtime.js", async () => ({
    withSessionEntryReadOnlyInWorker: (
      await import("../../../config/sessions/session-entry-read-runtime.js")
    ).withSessionEntryReadOnlyInWorker,
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
    forkSessionFromParent:
      params.forkSessionFromParentMock ??
      (async () => ({ sessionId: "forked-session-id", sessionFile: "/tmp/forked-session.jsonl" })),
    getGlobalHookRunner: () => params.hookRunner ?? { hasHooks: () => false },
    emitSessionLifecycleEvent: (...args: unknown[]) =>
      params.emitSessionLifecycleEventMock?.(...args),
    formatThinkingLevels: (levels: string[]) => levels.join(", "),
    normalizeThinkLevel: (level: unknown) => normalizeOptionalString(level),
    DEFAULT_SUBAGENT_MAX_CHILDREN_PER_AGENT: 5,
    ADMIN_SCOPE: "operator.admin",
    AGENT_LANE_SUBAGENT: "subagent",
    getRuntimeConfig: () =>
      params.getRuntimeConfig?.() ??
      createSubagentSpawnTestConfig(params.workspaceDir ?? os.tmpdir()),
    prepareModelChoice: params.prepareModelChoiceMock ?? supportedSpawnModelChoice,
    loadSessionEntry: (scope: { storePath?: string; sessionKey: string }) =>
      ((params.loadSessionStoreMock?.(scope.storePath) ?? {}) as SessionStore)[scope.sessionKey],
    loadSessionStore: params.loadSessionStoreMock ?? (() => ({})),
    ensureContextEnginesInitialized:
      params.ensureContextEnginesInitializedMock ?? (() => undefined),
    resolveContextEngine: params.resolveContextEngineMock ?? (async () => ({})),
    resolveParentForkDecision:
      params.resolveParentForkDecisionMock ??
      (async (forkParams: { parentEntry?: { totalTokens?: unknown } }) => {
        const maxTokens = 100_000;
        const parentTokens =
          typeof forkParams.parentEntry?.totalTokens === "number" &&
          Number.isFinite(forkParams.parentEntry.totalTokens)
            ? Math.floor(forkParams.parentEntry.totalTokens)
            : undefined;
        if (maxTokens > 0 && typeof parentTokens === "number" && parentTokens > maxTokens) {
          return {
            status: "skip",
            reason: "parent-too-large",
            maxTokens,
            parentTokens,
            message: `Parent context is too large to fork (${parentTokens}/${maxTokens} tokens); starting with isolated context instead.`,
          };
        }
        return {
          status: "fork",
          maxTokens,
          ...(typeof parentTokens === "number" ? { parentTokens } : {}),
        };
      }),
    mergeSessionEntry: (
      current: Record<string, unknown> | undefined,
      next: Record<string, unknown>,
    ) => ({
      ...current,
      ...next,
    }),
    updateSessionStore:
      params.updateSessionStoreMock ??
      (async (_storePath: string, mutator: SessionStoreMutator) => {
        const store: SessionStore = {};
        await mutator(store);
        return store;
      }),
    // Real scope resolver: spawn's admin-tier pinning depends on params-aware
    // sessions.patch policy, so a stub here would hide policy regressions.
    resolveLeastPrivilegeOperatorScopesForMethod,
    applySessionEntryCanonicalReplacements: (async (replacement) => {
      const updateSessionStore =
        params.updateSessionStoreMock ??
        (async (_storePath: string, mutator: SessionStoreMutator) => {
          const store: SessionStore = {};
          await mutator(store);
          return store;
        });
      const entries = (replacement.sessionKeys ?? []).flatMap((sessionKey) => {
        const store = params.loadSessionStoreMock?.(replacement.storePath);
        const raw = isRecord(store) ? store[sessionKey] : undefined;
        if (!isRecord(raw) || typeof raw.sessionId !== "string") {
          return [];
        }
        const entry: SessionEntry = {
          ...raw,
          sessionId: raw.sessionId,
          updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
        };
        return [{ sessionKey, entry }];
      });
      const operation = await replacement.update(entries);
      const commit = async (assertSourceCurrent?: () => void) => {
        assertSourceCurrent?.();
        replacement.assertCommitAllowed?.();
        await updateSessionStore(replacement.storePath, (store: SessionStore) => {
          for (const row of operation.replacements ?? []) {
            store[row.sessionKey] = { ...row.entry };
          }
        });
        return operation.result;
      };
      return replacement.withCommit ? await replacement.withCommit(commit) : await commit();
    }) satisfies typeof applySessionEntryCanonicalReplacements,
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
    resolveConversationDeliveryTarget:
      params.resolveConversationDeliveryTarget ??
      ((targetParams: { channel?: string; conversationId?: string | number }) => ({
        to: targetParams.conversationId
          ? `channel:${String(targetParams.conversationId)}`
          : undefined,
      })),
    mergeDeliveryContext: (
      primary?: Record<string, unknown>,
      fallback?: Record<string, unknown>,
    ) => ({
      ...fallback,
      ...primary,
    }),
    resolveGatewaySessionStoreTarget: (targetParams: { key: string }) => ({
      agentId: "main",
      storePath: params.sessionStorePath ?? "/tmp/subagent-spawn-model-session.json",
      canonicalKey: targetParams.key,
      storeKeys: [targetParams.key],
    }),
    normalizeDeliveryContext: identityDeliveryContext,
    resolveAgentConfig: params.resolveAgentConfig ?? (() => undefined),
    resolveAgentWorkspaceDir:
      params.resolveAgentWorkspaceDir ?? (() => params.workspaceDir ?? os.tmpdir()),
    resolveSandboxRuntimeStatus:
      params.resolveSandboxRuntimeStatus ?? (() => ({ sandboxed: false })),
    ...createDefaultSessionHelperMocks(),
  }));

  // The same fixture store serves the native async policy reader and legacy spawn lookups.
  vi.doMock("../../../config/sessions/session-entry-read-runtime.js", async () => {
    const actual = await vi.importActual<
      typeof import("../../../config/sessions/session-entry-read-runtime.js")
    >("../../../config/sessions/session-entry-read-runtime.js");
    const withSessionEntryReadOnlyInWorker: typeof actual.withSessionEntryReadOnlyInWorker = async (
      input,
      assertCurrent,
      consume,
    ) => {
      assertCurrent();
      const raw = ((params.loadSessionStoreMock?.(input.storePath) ?? {}) as SessionStore)[
        input.sessionKey
      ];
      const value =
        raw && typeof raw.sessionId === "string"
          ? {
              ...raw,
              sessionId: raw.sessionId,
              updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
            }
          : undefined;
      return await consume({ ok: true, value }, assertCurrent);
    };
    return { ...actual, withSessionEntryReadOnlyInWorker };
  });

  vi.doMock("./subagent-depth.js", () => ({
    getSubagentDepthFromSessionStore: params.getSubagentDepthFromSessionStore ?? (() => 0),
  }));

  vi.doMock("../registry/subagent-registry.js", () => ({
    completeCollectorLaunchCleanup: params.completeCollectorLaunchCleanupMock ?? vi.fn(),
    countActiveRunsForSession: params.countActiveRunsForSession ?? (() => 0),
    listSwarmRunsForGroup: params.listSwarmRunsForGroup ?? vi.fn(() => []),
    registerSubagentRun: vi.fn(
      (record: RegisterSubagentRunParams, options?: RegisterSubagentRunOptions) => {
        if (!record.queued || !options?.retainOwnership) {
          return params.registerSubagentRunMock?.(record, options);
        }
        let retained = false;
        const result = params.registerSubagentRunMock?.(record, {
          ...options,
          retainOwnership(scope) {
            retained = true;
            options.retainOwnership?.(scope);
          },
        } satisfies RegisterSubagentRunOptions);
        return Promise.resolve(result).then(() => {
          // Successful queued registration transfers custody; stricter test scopes win.
          if (!retained) {
            options.retainOwnership?.({
              canLaunch: () => true,
              canAcceptLaunch: () => true,
              canCleanupSession: () => true,
              canRetireReservation: () => true,
              waitForClaim: () => undefined,
              waitForRetirementPublication: () => undefined,
              settleFailedLaunch: async (error) => {
                params.settleFailedQueuedSubagentLaunchMock?.(record.runId, error);
              },
            });
          }
        });
      },
    ),
    resetSubagentRegistryForTests,
    settleFailedQueuedSubagentLaunch:
      params.settleFailedQueuedSubagentLaunchMock ?? vi.fn(() => true),
    startQueuedSubagentRun: params.startQueuedSubagentRunMock ?? vi.fn(() => true),
  }));

  const subagentSpawnModule = await import("./subagent-spawn.js");
  return {
    ...subagentSpawnModule,
    spawnSubagentDirect: withTestSpawnPolicy(subagentSpawnModule.spawnSubagentDirect),
    resetSubagentRegistryForTests,
  };
}

type InheritedSpawnPreferenceCase = {
  name: string;
  task: string;
  requesterState: Readonly<Record<string, unknown>>;
  preferenceKey: "thinkingLevel" | "fastMode";
  expected: string | boolean;
  agentDefaults?: Readonly<Record<string, unknown>>;
  requesterAgent?: Readonly<Record<string, unknown>>;
  collect?: boolean;
  requesterRunId?: string;
  requesterThinkingLevel?: ThinkLevel;
  thinkingOverride?: string;
};

export const inheritedSpawnPreferenceCases: readonly InheritedSpawnPreferenceCase[] = [
  {
    name: "inherits requester thinking level when no spawn or subagent default is configured",
    task: "inherit thinking",
    requesterState: { thinkingLevel: "high" },
    preferenceKey: "thinkingLevel",
    expected: "high",
  },
  {
    name: "inherits active-turn Ultra instead of the stored session thinking level",
    task: "inherit active thinking",
    requesterState: { thinkingLevel: "medium" },
    requesterThinkingLevel: "ultra",
    preferenceKey: "thinkingLevel",
    expected: "ultra",
  },
  {
    name: "inherits active-turn off instead of a stored Ultra override",
    task: "inherit active thinking off",
    requesterState: { thinkingLevel: "ultra" },
    requesterThinkingLevel: "off",
    preferenceKey: "thinkingLevel",
    expected: "off",
  },
  {
    name: "keeps explicit child thinking ahead of active-turn Ultra",
    task: "override active thinking",
    requesterState: { thinkingLevel: "medium" },
    requesterThinkingLevel: "ultra",
    thinkingOverride: "low",
    preferenceKey: "thinkingLevel",
    expected: "low",
  },
  {
    name: "inherits requester fast mode for collector children",
    task: "inherit fast mode",
    requesterState: { fastMode: "auto" },
    preferenceKey: "fastMode",
    expected: "auto",
    collect: true,
    requesterRunId: "parent-run",
  },
  {
    name: "inherits requester fast mode for ordinary children with default Swarm config",
    task: "inherit ordinary fast mode",
    requesterState: { fastMode: true },
    preferenceKey: "fastMode",
    expected: true,
  },
  {
    name: "persists inherited requester thinking off",
    task: "inherit thinking off",
    requesterState: { thinkingLevel: "off" },
    preferenceKey: "thinkingLevel",
    expected: "off",
  },
  {
    name: "inherits requester agent thinkingDefault when the caller session has no stored thinking",
    task: "inherit agent thinking default",
    requesterState: {},
    requesterAgent: { thinkingDefault: "high" },
    preferenceKey: "thinkingLevel",
    expected: "high",
  },
  {
    name: "inherits global thinkingDefault when caller session and agent have no stored thinking",
    task: "inherit global thinking default",
    requesterState: {},
    agentDefaults: { thinkingDefault: "medium" },
    preferenceKey: "thinkingLevel",
    expected: "medium",
  },
  {
    name: "applies requester-agent subagent thinking before active-turn thinking",
    task: "requester policy thinking",
    requesterState: { thinkingLevel: "high" },
    requesterAgent: { subagents: { thinking: "medium" } },
    requesterThinkingLevel: "ultra",
    preferenceKey: "thinkingLevel",
    expected: "medium",
  },
];
