import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import { abortEmbeddedAgentRun } from "../../agents/embedded-agent-runner/runs.js";
import { testing as embeddedRunTesting } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAssistantMessageFixture } from "../../agents/test-helpers/assistant-message-fixtures.js";
import {
  isTestCliProvider,
  runInitialModelFallbackAttempt,
  runFallbackModelAttempt,
  type TestModelFallbackRunnerParams,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import { createUsageFixture } from "../../agents/test-helpers/usage-fixtures.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
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

export function sessionFixture(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId: "session", updatedAt: Date.now(), ...overrides };
}

export function sessionState(sessionKey: string, sessionEntry: SessionEntry) {
  return { sessionKey, sessionEntry, sessionStore: { [sessionKey]: sessionEntry } };
}

export async function storedSession(
  overrides: Partial<SessionEntry> = {},
  sessionKey = "main",
  tmp = tempDirs.make("openclaw-reply-"),
) {
  const storePath = path.join(tmp, "sessions.json");
  const sessionEntry = sessionFixture(overrides);
  await replaceSessionEntry({ storePath, sessionKey }, sessionEntry);
  return {
    tmp,
    storePath,
    sessionKey,
    sessionEntry,
    scope: { agentId: "main", sessionId: sessionEntry.sessionId, sessionKey, storePath },
    reply: { ...sessionState(sessionKey, sessionEntry), storePath },
  };
}

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
    resolveSwarmLaunchReplay: async () => ({ status: "missing" }),
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

export function registerRawTracePayloadTest({
  run,
}: {
  run: (
    sessionKey: string,
    reply: Awaited<ReturnType<typeof storedSession>>["reply"],
  ) => Promise<unknown>;
}): void {
  it("appends raw trace payloads with escaped fences when trace raw is enabled", async () => {
    const { tmp, sessionKey, scope, reply } = await storedSession({
      traceLevel: "raw",
    });
    const transcript = await SessionManager.openAsync(scope, tmp);
    await transcript.appendMessageAsync({ role: "user", content: "Earlier turn", timestamp: 0 });
    await transcript.appendMessageAsync(
      makeAssistantMessageFixture({
        content: [{ type: "text", text: "Earlier reply" }],
        stopReason: "stop",
        errorMessage: undefined,
        usage: {
          ...createUsageFixture(200, 10, 235),
          cacheRead: 20,
          cacheWrite: 5,
        },
      }),
    );

    runWithModelFallbackMock.mockImplementationOnce(async (params: RunWithModelFallbackParams) => ({
      result: await runFallbackModelAttempt(params, "anthropic", "claude", "timeout"),
      provider: "anthropic",
      model: "claude",
      attempts: [
        {
          provider: "openai",
          model: "gpt-5.5",
          error: "LLM request timed out.",
          reason: "timeout",
          status: 408,
        },
      ],
    }));
    runEmbeddedAgentMock.mockImplementationOnce(async () => {
      return {
        payloads: [{ text: "Visible reply" }],
        meta: {
          finalPromptText:
            "Context:\n<active_memory_plugin>\nPrefer from/to failover logs.\n</active_memory_plugin>\n\n/trace raw show me everything\n~~~\nnot a fence",
          finalAssistantVisibleText: "Visible reply",
          finalAssistantRawText: "<final>Visible reply\n~~~\nresponse</final>",
          executionTrace: {
            winnerProvider: "anthropic",
            winnerModel: "claude",
            runner: "embedded",
            fallbackUsed: false,
            attempts: [
              {
                provider: "anthropic",
                model: "claude",
                result: "success",
                stage: "assistant",
                elapsedMs: 4200,
              },
            ],
          },
          agentMeta: {
            sessionId: "session",
            provider: "anthropic",
            model: "claude",
            usage: { input: 1200, output: 45, cacheRead: 800, cacheWrite: 200, total: 2245 },
            lastCallUsage: {
              input: 1000,
              output: 45,
              cacheRead: 750,
              cacheWrite: 150,
              total: 1945,
            },
            promptTokens: 1250,
            compactionCount: 1,
          },
        },
      };
    });

    const result = await run(sessionKey, reply);

    expect(Array.isArray(result)).toBe(true);
    expect((result as { text?: string }[])[0]?.text).toBe("Visible reply");
    const traceText = (result as { text?: string }[])[1]?.text ?? "";
    expect(traceText).toContain("🔎 Usage (Session Total):");
    expect(traceText).toContain("🔎 Usage (Last Turn Total):");
    expect(traceText).toContain("used=1,250 tok (1.3k)");
    expect(traceText).toContain("winner=anthropic/claude");
    expect(traceText).toContain("fallbackUsed=yes");
    expect(traceText).toContain("attempts=2");
    expect(traceText).toContain("1. openai/gpt-5.5");
    expect(traceText).toContain("result=timeout");
    expect(traceText).toContain("status=408");
    expect(traceText).toContain("2. anthropic/claude");
    expect(traceText).toContain("result=success");
    expect(traceText).toContain("🔎 Model Input (User Role):");
    expect(traceText).toContain("🔎 Model Output (Assistant Role):");
    expect(traceText).toContain("show me everything\n\\~~~\nnot a fence");
    expect(traceText).toContain("<final>Visible reply\n\\~~~\nresponse</final>");
  });
}
