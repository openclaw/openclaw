// Integration test pinning the runner-side `continuation.work` span emission
// contract.
//
// We install a recording tracer via `setContinuationTracer`, drive the
// runner with CONTINUE_WORK over multiple chain steps, and assert:
//   1. accepted WORK turn → exactly one `continuation.work` span, with
//      a UUIDv7 `chain.id` and clamped `chain.step.remaining`
//   2. the chain.id is stable across two consecutive accepted steps
//      (mint-at-0→1, reuse-for-step-2 contract)
//   3. crossing `maxChainLength` → cap-reject path → no new
//      `continuation.work` span emitted (rejected requests don't
//      advance the chain, so they MUST NOT emit `continuation.work`)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testing as embeddedRunTesting,
  abortEmbeddedPiRun,
  isEmbeddedPiRunActive,
} from "../../agents/pi-embedded-runner/runs.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  resetContinuationTracer,
  setContinuationTracer,
  type Span,
  type SpanAttributes,
  type SpanStatus,
  type StartSpanOptions,
  type Tracer,
} from "../../infra/continuation-tracer.js";
import {
  clearMemoryPluginState,
  registerMemoryFlushPlanResolver,
} from "../../plugins/memory-state.js";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { __testing as replyRunRegistryTesting } from "./reply-run-registry.js";
import { createMockTypingController } from "./test-helpers.js";

// Suppress unused-import diagnostic — registerMemoryFlushPlanResolver is
// imported because some siblings register a stub; not strictly required
// here, kept for parity with the misc.runreplyagent harness.
void registerMemoryFlushPlanResolver;

const runEmbeddedPiAgentMock = vi.fn();
const runCliAgentMock = vi.fn();
const runWithModelFallbackMock = vi.fn();
const runtimeErrorMock = vi.fn();
const abortEmbeddedPiRunMock = vi.fn();
const clearSessionQueuesMock = vi.fn();
const refreshQueuedFollowupSessionMock = vi.fn();
const compactState = vi.hoisted(() => ({
  compactEmbeddedPiSessionMock: vi.fn(),
}));
const requestHeartbeatNowMock = vi.hoisted(() => vi.fn());
const spawnSubagentDirectMock = vi.hoisted(() => vi.fn());

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: (params: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => runWithModelFallbackMock(params),
  isFallbackSummaryError: (err: unknown) =>
    err instanceof Error &&
    err.name === "FallbackSummaryError" &&
    Array.isArray((err as { attempts?: unknown[] }).attempts),
}));

vi.mock("../../agents/model-auth.js", () => ({
  resolveModelAuthMode: () => "api-key",
}));

vi.mock("../../agents/pi-embedded.js", () => {
  return {
    compactEmbeddedPiSession: (params: unknown) =>
      compactState.compactEmbeddedPiSessionMock(params),
    queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
    runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
    abortEmbeddedPiRun: (sessionId: string) => {
      abortEmbeddedPiRunMock(sessionId);
      return abortEmbeddedPiRun(sessionId);
    },
    isEmbeddedPiRunActive: (sessionId: string) => isEmbeddedPiRunActive(sessionId),
  };
});

vi.mock("../../agents/cli-runner.js", () => ({
  runCliAgent: (...args: unknown[]) => runCliAgentMock(...args),
}));

vi.mock("../../agents/subagent-spawn.js", () => ({
  SUBAGENT_SPAWN_MODES: ["run", "session"],
  SUBAGENT_SPAWN_SANDBOX_MODES: ["inherit", "require"],
  SUBAGENT_SPAWN_CONTEXT_MODES: ["isolated", "fork"],
  spawnSubagentDirect: (...args: unknown[]) => spawnSubagentDirectMock(...args),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    log: vi.fn(),
    error: (...args: unknown[]) => runtimeErrorMock(...args),
    exit: vi.fn(),
  },
}));

vi.mock("../../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow: (...args: unknown[]) => requestHeartbeatNowMock(...args),
}));

vi.mock("./queue.js", () => ({
  enqueueFollowupRun: vi.fn(),
  scheduleFollowupDrain: vi.fn(),
  clearSessionQueues: (...args: unknown[]) => clearSessionQueuesMock(...args),
  refreshQueuedFollowupSession: (...args: unknown[]) => refreshQueuedFollowupSessionMock(...args),
}));

vi.mock("../../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: async ({ config }: { config: unknown }) => ({
    resolvedConfig: config,
    diagnostics: [],
  }),
}));

vi.mock("../../utils/provider-utils.js", () => ({
  isReasoningTagProvider: (provider: string | undefined | null) =>
    provider === "google" || provider === "google-gemini-cli",
}));

const loadCronStoreMock = vi.fn();
vi.mock("../../cron/store.js", () => ({
  loadCronStore: (...args: unknown[]) => loadCronStoreMock(...args),
  resolveCronStorePath: (storePath?: string) => storePath ?? "/tmp/openclaw-cron-store.json",
}));

vi.mock("../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    resolveSession: () => ({ kind: "none" }),
    cancelSession: async () => {},
  }),
}));

vi.mock("../../agents/subagent-registry.js", () => ({
  getLatestSubagentRunByChildSessionKey: () => null,
  listSubagentRunsForController: () => [],
  markSubagentRunTerminated: () => 0,
}));

import { runReplyAgent } from "./agent-runner.js";

type RunWithModelFallbackParams = {
  provider: string;
  model: string;
  run: (provider: string, model: string) => Promise<unknown>;
};

type RecordedSpan = {
  name: string;
  attributes: SpanAttributes;
  status: SpanStatus | undefined;
  ended: boolean;
};

function createRecordingTracer(): { tracer: Tracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const tracer: Tracer = {
    startSpan(name: string, opts?: StartSpanOptions): Span {
      const rec: RecordedSpan = {
        name,
        attributes: { ...opts?.attributes },
        status: undefined,
        ended: false,
      };
      spans.push(rec);
      const span: Span = {
        setAttributes(attrs: SpanAttributes): void {
          Object.assign(rec.attributes, attrs);
        },
        setStatus(status: SpanStatus, _message?: string): void {
          rec.status = status;
        },
        recordException(_err: unknown): void {
          // not used by `continuation.work` accept path
        },
        end(): void {
          rec.ended = true;
        },
      };
      return span;
    },
  };
  return { tracer, spans };
}

beforeEach(() => {
  embeddedRunTesting.resetActiveEmbeddedRuns();
  replyRunRegistryTesting.resetReplyRunRegistry();
  runEmbeddedPiAgentMock.mockClear();
  runCliAgentMock.mockClear();
  runWithModelFallbackMock.mockClear();
  runtimeErrorMock.mockClear();
  abortEmbeddedPiRunMock.mockClear();
  compactState.compactEmbeddedPiSessionMock.mockReset();
  compactState.compactEmbeddedPiSessionMock.mockResolvedValue({
    compacted: false,
    reason: "test-preflight-disabled",
  });
  clearSessionQueuesMock.mockReset();
  clearSessionQueuesMock.mockReturnValue({ followupCleared: 0, laneCleared: 0, keys: [] });
  refreshQueuedFollowupSessionMock.mockReset();
  refreshQueuedFollowupSessionMock.mockResolvedValue(undefined);
  loadCronStoreMock.mockClear();
  loadCronStoreMock.mockResolvedValue({ version: 1, jobs: [] });
  requestHeartbeatNowMock.mockReset();
  spawnSubagentDirectMock.mockReset().mockResolvedValue({
    status: "accepted",
    childSessionKey: "agent:main:subagent:spawned",
    runId: "run-spawned",
  });
  runWithModelFallbackMock.mockImplementation(
    async ({ provider, model, run }: RunWithModelFallbackParams) => ({
      result: await run(provider, model),
      provider,
      model,
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  clearRuntimeConfigSnapshot();
  clearMemoryPluginState();
  replyRunRegistryTesting.resetReplyRunRegistry();
  embeddedRunTesting.resetActiveEmbeddedRuns();
  resetContinuationTracer();
});

const UUIDV7_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function createContinuationRun(params?: {
  sessionKey?: string;
  config?: Record<string, unknown>;
  sessionEntry?: SessionEntry;
}) {
  const sessionKey = params?.sessionKey ?? "continuation-work-span";
  const typing = createMockTypingController();
  const sessionCtx = {
    Provider: "discord",
    OriginatingTo: "channel:1",
    AccountId: "primary",
    MessageSid: "msg",
  } as unknown as TemplateContext;
  const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
  const sessionEntry =
    params?.sessionEntry ??
    ({
      sessionId: "session",
      updatedAt: Date.now(),
    } satisfies SessionEntry);
  const followupRun = {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    run: {
      sessionId: "session",
      sessionKey,
      messageProvider: "discord",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config:
        params?.config ??
        ({
          agents: {
            defaults: {
              continuation: {
                enabled: true,
                minDelayMs: 0,
                maxDelayMs: 1_000,
                defaultDelayMs: 1_000,
                maxChainLength: 2,
              },
            },
          },
        } satisfies Record<string, unknown>),
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude",
      thinkLevel: "low",
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: {
        enabled: false,
        allowed: false,
        defaultLevel: "off",
      },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
  } as unknown as FollowupRun;

  return { sessionKey, sessionEntry, typing, sessionCtx, resolvedQueue, followupRun };
}

async function runWorkTurn(
  run: ReturnType<typeof createContinuationRun>,
  sessionStore: Record<string, SessionEntry>,
  _payloadText: string,
): Promise<unknown> {
  setRuntimeConfigSnapshot(run.followupRun.run.config);
  return runReplyAgent({
    commandBody: "hello",
    followupRun: run.followupRun,
    queueKey: run.sessionKey,
    resolvedQueue: run.resolvedQueue,
    shouldSteer: false,
    shouldFollowup: false,
    isActive: false,
    isStreaming: false,
    typing: run.typing,
    sessionCtx: run.sessionCtx,
    sessionEntry: run.sessionEntry,
    sessionStore,
    sessionKey: run.sessionKey,
    defaultModel: "anthropic/claude-opus-4-6",
    resolvedVerboseLevel: "off",
    isNewSession: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    shouldInjectGroupIntro: false,
    typingMode: "instant",
  });
}

describe("runReplyAgent :: continuation.work span", () => {
  it("emits exactly one `continuation.work` span on accepted WORK with UUIDv7 chain.id and clamped chain.step.remaining", async () => {
    vi.useFakeTimers();
    const { tracer, spans } = createRecordingTracer();
    setContinuationTracer(tracer);

    const run = createContinuationRun({ sessionKey: "continuation-work-span-accept" });
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Working on it\nCONTINUE_WORK:1" }],
      meta: { agentMeta: { usage: { input: 2, output: 3 } } },
    });

    await runWorkTurn(
      run,
      { [run.sessionKey]: run.sessionEntry },
      "Working on it\nCONTINUE_WORK:1",
    );

    const workSpans = spans.filter((s) => s.name === "continuation.work");
    expect(workSpans).toHaveLength(1);

    const span = workSpans[0];
    if (!span) {
      throw new Error("expected a recorded continuation.work span");
    }
    expect(span.status).toBe("OK");
    expect(span.ended).toBe(true);

    const attrs = span.attributes;
    expect(attrs["delay.ms"]).toBe(1_000);
    // maxChainLength=2, nextChainCount=1 → remaining=1 (clamped to ≥0)
    expect(attrs["chain.step.remaining"]).toBe(1);
    // UUIDv7 minted by persistContinuationChainState on the 0→1
    // transition; emitter consumes the same id (no re-derivation)
    expect(typeof attrs["chain.id"]).toBe("string");
    expect(attrs["chain.id"] as string).toMatch(UUIDV7_REGEX);
  });

  it("reuses chain.id across consecutive accepted steps (mint-at-0→1, reuse-for-step-2)", async () => {
    vi.useFakeTimers();
    const { tracer, spans } = createRecordingTracer();
    setContinuationTracer(tracer);

    // Pre-seed the session entry with an existing chain.id at
    // continuationChainCount=1, simulating a fresh chain that has
    // already taken its first step. The next accepted WORK should
    // bump count to 2 and REUSE the same chain.id (mint-or-reuse
    // contract). chain.step.remaining = max(0, maxChainLength=2 - 2) = 0.
    const seededChainId = "019dcf57-b536-77cc-834b-b803d9262032";
    const seededEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      continuationChainCount: 1,
      continuationChainStartedAt: Date.now() - 10_000,
      continuationChainTokens: 100,
      continuationChainId: seededChainId,
    };
    const run = createContinuationRun({
      sessionKey: "continuation-work-span-stable",
      sessionEntry: seededEntry,
    });
    const sessionStore = { [run.sessionKey]: seededEntry };

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Step two\nCONTINUE_WORK:1" }],
      meta: { agentMeta: { usage: { input: 1, output: 1 } } },
    });
    await runWorkTurn(run, sessionStore, "Step two\nCONTINUE_WORK:1");

    const workSpans = spans.filter((s) => s.name === "continuation.work");
    expect(workSpans).toHaveLength(1);

    const span = workSpans[0];
    if (!span) {
      throw new Error("expected a recorded continuation.work span");
    }
    // CRITICAL: chain.id MUST be the seeded value, not a freshly minted
    // UUIDv7 — proves mint-or-reuse picks the existing one.
    expect(span.attributes["chain.id"]).toBe(seededChainId);
    expect(span.attributes["chain.step.remaining"]).toBe(0);
  });

  it("does NOT emit `continuation.work` on the chain-cap reject path (rejected requests don't advance the chain)", async () => {
    vi.useFakeTimers();
    const { tracer, spans } = createRecordingTracer();
    setContinuationTracer(tracer);

    // Pre-seed at maxChainLength=2 — the next CONTINUE_WORK request
    // hits chain-cap reject and MUST NOT emit `continuation.work`.
    const seededChainId = "019dcf57-aaaa-77cc-834b-b803d9262032";
    const seededEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      continuationChainCount: 2, // already at maxChainLength
      continuationChainStartedAt: Date.now() - 20_000,
      continuationChainTokens: 200,
      continuationChainId: seededChainId,
    };
    const run = createContinuationRun({
      sessionKey: "continuation-work-span-cap",
      sessionEntry: seededEntry,
    });
    const sessionStore = { [run.sessionKey]: seededEntry };

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Step 3 attempts\nCONTINUE_WORK:1" }],
      meta: { agentMeta: { usage: { input: 1, output: 1 } } },
    });
    await runWorkTurn(run, sessionStore, "Step 3 attempts\nCONTINUE_WORK:1");

    // No `continuation.work` span emitted — accept-only contract.
    const workSpans = spans.filter((s) => s.name === "continuation.work");
    expect(workSpans).toHaveLength(0);

    // The chain-cap reject branch emits exactly one `continuation.disabled`
    // span. Span carries `disabled.reason =
    // cap.chain` and `signal.kind = bracket-work` (CONTINUE_WORK signal).
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      name: "continuation.disabled",
      attributes: {
        "disabled.reason": "cap.chain",
        "signal.kind": "bracket-work",
        "continuation.disabled": true,
        "chain.id": seededChainId,
      },
    });
  });
});
