import { afterEach, beforeEach, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import {
  abortEmbeddedAgentRun,
  isEmbeddedAgentRunActive,
} from "../../agents/embedded-agent-runner/runs.js";
import { testing as embeddedRunTesting } from "../../agents/embedded-agent-runner/runs.test-support.js";
import {
  runInitialModelFallbackAttempt,
  type TestModelFallbackRunnerParams,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { resetDiagnosticEventsForTest } from "../../infra/diagnostic-events.js";
import { resetSystemEventsForTest } from "../../infra/system-events.js";
import { clearMemoryPluginState } from "../../plugins/memory-state.test-fixtures.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { enqueueFollowupRun, scheduleFollowupDrain } from "./queue.js";
import { testing as replyRunRegistryTesting } from "./reply-run-registry.test-support.js";

export const tempDirs = createTempDirTracker();
export let rootDir: string;

function registerCliBackendsForTest(): void {
  const backends = (
    [
      ["claude-cli", "anthropic", "claude"],
      ["google-gemini-cli", "google", "gemini"],
    ] as const
  ).map(([id, provider, command]) => ({
    id,
    modelProvider: provider,
    pluginId: provider,
    config: { command },
    bundleMcp: false,
  }));
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: ({ backend }) => {
      const resolved = backends.find((entry) => entry.id === backend);
      return resolved ? { pluginId: resolved.pluginId, backend: resolved } : undefined;
    },
    resolvePluginSetupRegistry: () => ({
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    }),
    resolveRuntimeCliBackends: () => [...backends],
  });
}

export const runEmbeddedAgentMock = vi.fn();
export const runCliAgentMock = vi.fn();
export const runWithModelFallbackMock = vi.fn();
export const runtimeErrorMock = vi.fn();
export const compactState = vi.hoisted(() => ({
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

vi.mock("../../agents/embedded-agent.js", () => ({
  compactEmbeddedAgentSession: (
    ...args: Parameters<typeof import("../../agents/embedded-agent.js").compactEmbeddedAgentSession>
  ) => compactState.compactEmbeddedAgentSessionMock(...args),
  runEmbeddedAgent: (params: unknown) => runEmbeddedAgentMock(params),
  abortEmbeddedAgentRun: (sessionId: string) => abortEmbeddedAgentRun(sessionId),
  isEmbeddedAgentRunActive,
}));

vi.mock("../../agents/cli-runner.js", () => ({
  runCliAgent: (...args: unknown[]) => runCliAgentMock(...args),
}));

vi.mock("../../agents/model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/model-selection.js")>()),
  isCliProvider: (provider: string) =>
    ["claude-cli", "google-gemini-cli", "codex-cli"].includes(provider.trim().toLowerCase()),
}));

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

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    log: vi.fn(),
    error: (...args: unknown[]) => runtimeErrorMock(...args),
    exit: vi.fn(),
  },
}));

// mock-isolation: Keep the process-wide followup queue and drain registry outside runner cases.
vi.mock("./queue.js", async () => {
  const { resolveFollowupAbortSignal } = await import("./queue/types.js");
  return {
    admitFollowupRunLifecycle: vi.fn(async () => {}),
    enqueueFollowupRun: vi.fn(),
    kickFollowupDrainIfIdle: vi.fn(),
    parkSteerCandidate: vi.fn(() => ({
      admit: async () => "steer",
      accepted: vi.fn(),
      fallback: vi.fn(),
      consume: vi.fn(),
    })),
    resolveFollowupAbortSignal,
    scheduleFollowupDrain: vi.fn(),
    refreshQueuedFollowupSession: async () => undefined,
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

export const loadCronStoreMock = vi.fn();
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

vi.mock("../../agents/subagents/registry/subagent-registry.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../agents/subagents/registry/subagent-registry.js")
  >()),
  getSwarmRunByLaunchReplayKey: async () => undefined,
  markSubagentRunTerminated: () => 0,
}));
vi.mock("../../agents/subagents/registry/subagent-registry-read.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../agents/subagents/registry/subagent-registry-read.js")
  >()),
  getLatestSubagentRunByChildSessionKey: async () => null,
}));

// #85714: exercise real suppression, spying only its WARN emitter.
export const warnPrivateFinalSpy = vi.hoisted(() => vi.fn());
vi.mock("./private-message-tool-final.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./private-message-tool-final.js")>()),
  warnPrivateMessageToolFinal: warnPrivateFinalSpy,
}));

function setupAgentRunnerMocks(): void {
  rootDir = tempDirs.make("openclaw-run-reply-agent-");
  vi.useRealTimers();
  registerCliBackendsForTest();
  clearRuntimeConfigSnapshot();
  setRuntimeConfigSnapshot({});
  resetDiagnosticEventsForTest();
  resetSystemEventsForTest();
  embeddedRunTesting.resetActiveEmbeddedRuns();
  replyRunRegistryTesting.resetReplyRunRegistry();
  warnPrivateFinalSpy.mockClear();
  runEmbeddedAgentMock.mockReset();
  runCliAgentMock.mockReset();
  runWithModelFallbackMock.mockReset();
  runtimeErrorMock.mockReset();
  vi.mocked(enqueueFollowupRun).mockReset();
  vi.mocked(scheduleFollowupDrain).mockReset();
  compactState.compactEmbeddedAgentSessionMock.mockReset().mockResolvedValue({
    compacted: false,
    reason: "test-preflight-disabled",
  });
  loadCronStoreMock.mockReset().mockResolvedValue({ version: 1, jobs: [] });

  runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => ({
    result: await runInitialModelFallbackAttempt(params),
    provider: params.provider,
    model: params.model,
    attempts: [],
  }));
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
    replyRunRegistryTesting.resetReplyRunRegistry();
    embeddedRunTesting.resetActiveEmbeddedRuns();
    for (const stateDir of tempDirs.dirs) {
      await cleanupSessionStateForTest({ stateDir });
    }
    tempDirs.cleanup();
  });
}
