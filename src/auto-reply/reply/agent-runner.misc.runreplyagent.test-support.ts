import { afterEach, beforeEach, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import { abortEmbeddedAgentRun } from "../../agents/embedded-agent-runner/runs.js";
import { testing as embeddedRunTesting } from "../../agents/embedded-agent-runner/runs.test-support.js";
import {
  isTestCliProvider,
  runInitialModelFallbackAttempt,
  type TestModelFallbackRunnerParams,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { resetDiagnosticEventsForTest } from "../../infra/diagnostic-events.js";
import { resetSystemEventsForTest } from "../../infra/system-events.js";
import { clearMemoryPluginState } from "../../plugins/memory-state.test-fixtures.js";
import { createEmptyPluginSetupRegistry } from "../../plugins/setup-registry.test-support.js";
import { isSessionRunActive } from "../../sessions/session-controller.queries.js";
import { testing as controllerTesting } from "../../sessions/session-controller.test-support.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { enqueueFollowupRun, scheduleFollowupDrain } from "./queue.js";

const tempDirs = createTempDirTracker();
let rootDir: string;

function registerCliBackendsForTest(): void {
  const backends = [
    {
      id: "claude-cli",
      modelProvider: "anthropic",
      pluginId: "anthropic",
      config: { command: "claude" },
      bundleMcp: false,
    },
    {
      id: "google-gemini-cli",
      modelProvider: "google",
      pluginId: "google",
      config: { command: "gemini" },
      bundleMcp: false,
    },
  ] as const;
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: ({ backend }) => {
      const resolved = backends.find((entry) => entry.id === backend);
      return resolved ? { pluginId: resolved.pluginId, backend: resolved } : undefined;
    },
    resolvePluginSetupRegistry: () => createEmptyPluginSetupRegistry(),
    resolveRuntimeCliBackends: () => [...backends],
  });
}

const runEmbeddedAgentMock = vi.fn();
const runCliAgentMock = vi.fn();
const runWithModelFallbackMock = vi.fn();
const runtimeErrorMock = vi.fn();
const abortEmbeddedAgentRunMock = vi.fn();
const refreshQueuedFollowupSessionMock = vi.fn();
const compactState = vi.hoisted(() => ({
  compactEmbeddedAgentSessionMock: vi.fn(),
}));

vi.mock("../../agents/model-fallback-runner.js", () => ({
  runWithModelFallback: (params: TestModelFallbackRunnerParams) => runWithModelFallbackMock(params),
}));

vi.mock("../../agents/model-fallback-attempt.js", () => ({
  isFallbackSummaryError: (err: unknown) =>
    err instanceof Error &&
    err.name === "FallbackSummaryError" &&
    Array.isArray((err as { attempts?: unknown[] }).attempts),
}));

// mock-isolation: Reply-runner cases fix auth mode without reading host profiles or environment keys.
vi.mock("../../agents/model-auth.js", () => ({
  isMissingProviderAuthError: () => false,
  resolveModelAuthModeAsync: () => "api-key",
}));

vi.mock("../../agents/embedded-agent.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/embedded-agent.js")>();
  return {
    ...actual,
    compactEmbeddedAgentSession: (
      ...args: Parameters<
        typeof import("../../agents/embedded-agent.js").compactEmbeddedAgentSession
      >
    ) => compactState.compactEmbeddedAgentSessionMock(...args),
    runEmbeddedAgent: (params: unknown) => runEmbeddedAgentMock(params),
    abortEmbeddedAgentRun: (sessionId: string) => {
      abortEmbeddedAgentRunMock(sessionId);
      return abortEmbeddedAgentRun(sessionId);
    },
    isSessionRunActive: (sessionId: string) => isSessionRunActive(sessionId),
  };
});

vi.mock("../../agents/cli-runner.js", () => ({
  runCliAgent: (...args: unknown[]) => runCliAgentMock(...args),
}));

vi.mock("../../agents/model-selection.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/model-selection.js")>(
    "../../agents/model-selection.js",
  );
  return {
    ...actual,
    isCliProvider: isTestCliProvider,
  };
});

vi.mock("../../agents/thinking-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/thinking-runtime.js")>();
  return {
    ...actual,
    resolveCandidateAgentRuntime: () => "openclaw",
    resolveCandidateThinkingLevel: (
      params: Parameters<typeof actual.resolveCandidateThinkingLevel>[0],
    ) => params.level,
    resolveEffectiveAgentRuntime: () => "openclaw",
  };
});

vi.mock("../../runtime.js", () => {
  return {
    defaultRuntime: {
      log: vi.fn(),
      error: (...args: unknown[]) => runtimeErrorMock(...args),
      exit: vi.fn(),
    },
  };
});

vi.mock("./queue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./queue.js")>();
  return {
    ...actual,
    admitFollowupRunLifecycle: vi.fn(async () => {}),
    completeFollowupRunLifecycle: actual.completeFollowupRunLifecycle,
    enqueueFollowupRun: vi.fn(),
    reserveSteerCandidate: vi.fn(() => ({
      admit: async () => "steer",
      accepted: vi.fn(),
      fallback: vi.fn(),
      consume: vi.fn(),
    })),
    resolveFollowupAbortSignal: actual.resolveFollowupAbortSignal,
    scheduleFollowupDrain: vi.fn(),
    refreshQueuedFollowupSession: (...args: unknown[]) => refreshQueuedFollowupSessionMock(...args),
  };
});

vi.mock("../../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: async ({ config }: { config: unknown }) => ({
    resolvedConfig: config,
    diagnostics: [],
  }),
}));

// Dedicated suites cover these sidecars; misc runner cases keep them inert to avoid unrelated graphs.
vi.mock("../../cli/command-secret-targets.js", () => ({
  getAgentRuntimeCommandSecretTargetIds: () => new Set<string>(),
  getAgentRuntimeOptionalCommandSecretPaths: () => new Set<string>(),
  getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
}));

vi.mock("../../agents/harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: async () => undefined,
}));

vi.mock("./followup-runner.js", () => ({
  createFollowupRunner: () => vi.fn(async () => undefined),
}));

vi.mock("../../utils/provider-utils.js", () => ({
  isReasoningTagProvider: (provider: string | undefined | null) =>
    provider === "google" || provider === "google-gemini-cli",
}));

const loadCronStoreMock = vi.fn();
vi.mock("../../cron/store.js", () => {
  const resolveCronPath = (storePath?: string) => storePath ?? "/tmp/openclaw-cron-store.json";
  return {
    loadCronJobsStore: (...args: unknown[]) => loadCronStoreMock(...args),
    loadCronStore: (...args: unknown[]) => loadCronStoreMock(...args),
    resolveCronJobsStorePath: resolveCronPath,
    resolveCronStorePath: resolveCronPath,
  };
});

vi.mock("../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    resolveSession: () => ({ kind: "none" }),
    cancelSession: async () => {},
  }),
}));

vi.mock("../../agents/subagents/registry/subagent-registry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../agents/subagents/registry/subagent-registry.js")>();
  return {
    ...actual,
    getSwarmRunByLaunchReplayKey: async () => undefined,
    markSubagentRunTerminated: () => 0,
  };
});
vi.mock("../../agents/subagents/registry/subagent-registry-read.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../agents/subagents/registry/subagent-registry-read.js")
  >()),
  getLatestSubagentRunByChildSessionKey: async () => null,
}));

// #85714: keep the real private-final decision but spy the WARN emitter so we
// can assert it fires only through the substantive text suppression branch.
const warnPrivateFinalSpy = vi.hoisted(() => vi.fn());
vi.mock("./private-message-tool-final.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./private-message-tool-final.js")>();
  return { ...actual, warnPrivateMessageToolFinal: warnPrivateFinalSpy };
});

type RunWithModelFallbackParams = TestModelFallbackRunnerParams & {
  prepareCandidateChain?: (
    candidates: ReadonlyArray<{ provider: string; model: string }>,
  ) => Promise<void> | void;
};

function setupAgentRunnerMocks(): void {
  rootDir = tempDirs.make("openclaw-run-reply-agent-");
  vi.useRealTimers();
  registerCliBackendsForTest();
  clearRuntimeConfigSnapshot();
  setRuntimeConfigSnapshot({});
  resetDiagnosticEventsForTest();
  resetSystemEventsForTest();
  embeddedRunTesting.resetActiveEmbeddedRuns();
  controllerTesting.resetSessionControllerForTest();
  runEmbeddedAgentMock.mockReset();
  warnPrivateFinalSpy.mockClear();
  runCliAgentMock.mockReset();
  runWithModelFallbackMock.mockReset();
  runtimeErrorMock.mockReset();
  abortEmbeddedAgentRunMock.mockClear();
  compactState.compactEmbeddedAgentSessionMock.mockReset();
  compactState.compactEmbeddedAgentSessionMock.mockResolvedValue({
    compacted: false,
    reason: "test-preflight-disabled",
  });
  refreshQueuedFollowupSessionMock.mockReset();
  refreshQueuedFollowupSessionMock.mockResolvedValue(undefined);
  vi.mocked(enqueueFollowupRun).mockReset();
  vi.mocked(scheduleFollowupDrain).mockReset();
  loadCronStoreMock.mockReset();
  // Default: no cron jobs in store.
  loadCronStoreMock.mockResolvedValue({ version: 1, jobs: [] });

  // Default: no provider switch; execute the chosen provider+model.
  runWithModelFallbackMock.mockImplementation(async (params: RunWithModelFallbackParams) => {
    await params.prepareCandidateChain?.([{ provider: params.provider, model: params.model }]);
    const result = await runInitialModelFallbackAttempt(params);
    return {
      result,
      provider: params.provider,
      model: params.model,
      attempts: [],
    };
  });
}

export function setupAgentRunnerTestHooks(): void {
  beforeEach(setupAgentRunnerMocks);

  afterEach(async () => {
    cliBackendsTesting.resetDepsForTest();
    clearRuntimeConfigSnapshot();
    resetDiagnosticEventsForTest();
    resetSystemEventsForTest();
    vi.useRealTimers();
    clearMemoryPluginState();
    controllerTesting.resetSessionControllerForTest();
    embeddedRunTesting.resetActiveEmbeddedRuns();
    for (const stateDir of tempDirs.dirs) {
      await cleanupSessionStateForTest({ stateDir });
    }
    tempDirs.cleanup();
  });
}

export {
  compactState,
  loadCronStoreMock,
  rootDir,
  runCliAgentMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
  runtimeErrorMock,
  tempDirs,
  warnPrivateFinalSpy,
};
