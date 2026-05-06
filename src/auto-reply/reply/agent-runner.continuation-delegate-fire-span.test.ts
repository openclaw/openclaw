// Integration test pinning the runner-side `continuation.delegate.fire` span
// emission contract at the timer-callback seam before reservation lookup.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testing as embeddedRunTesting,
  abortEmbeddedPiRun,
  isEmbeddedPiRunActive,
} from "../../agents/pi-embedded-runner/runs.js";
import { createContinueDelegateTool } from "../../agents/tools/continue-delegate-tool.js";
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
import {
  clearDelayedContinuationReservations,
  enqueuePendingDelegate,
} from "../continuation/delegate-store.js";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { __testing as replyRunRegistryTesting } from "./reply-run-registry.js";
import { createMockTypingController } from "./test-helpers.js";

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

vi.mock("../../agents/pi-embedded.js", () => ({
  compactEmbeddedPiSession: (params: unknown) => compactState.compactEmbeddedPiSessionMock(params),
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
  abortEmbeddedPiRun: (sessionId: string) => {
    abortEmbeddedPiRunMock(sessionId);
    return abortEmbeddedPiRun(sessionId);
  },
  isEmbeddedPiRunActive: (sessionId: string) => isEmbeddedPiRunActive(sessionId),
}));

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
  traceparent: string | undefined;
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
        traceparent: opts?.traceparent,
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
          // unused
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
  const sessionKey = params?.sessionKey ?? "continuation-delegate-fire-span";
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
                maxDelayMs: 5_000,
                defaultDelayMs: 1_000,
                maxChainLength: 4,
                maxDelegatesPerTurn: 4,
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

async function runDelegateTurn(
  run: ReturnType<typeof createContinuationRun>,
  sessionStore: Record<string, SessionEntry>,
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

describe("runReplyAgent :: continuation.delegate.fire span", () => {
  it("bracket-delegate timer fire emits exactly one `continuation.delegate.fire` with chain.id matching the dispatch span", async () => {
    vi.useFakeTimers();
    const { tracer, spans } = createRecordingTracer();
    setContinuationTracer(tracer);

    const run = createContinuationRun({ sessionKey: "continuation-delegate-fire-bracket" });
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [
        {
          text: "Reply\n[[CONTINUE_DELEGATE: inspect logs +1s | traceparent=00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01]]",
        },
      ],
      meta: { agentMeta: { usage: { input: 1, output: 1 } } },
    });

    await runDelegateTurn(run, { [run.sessionKey]: run.sessionEntry });

    // Before timer fires: dispatch span recorded, fire span not yet.
    const dispatchSpans = spans.filter((s) => s.name === "continuation.delegate.dispatch");
    expect(dispatchSpans).toHaveLength(1);
    expect(dispatchSpans[0]?.traceparent).toBe(
      "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    );
    expect(spans.filter((s) => s.name === "continuation.delegate.fire")).toHaveLength(0);

    // Advance past the clamped delay (1000ms) to fire the timer callback.
    await vi.advanceTimersByTimeAsync(1_000);

    const fireSpans = spans.filter((s) => s.name === "continuation.delegate.fire");
    expect(fireSpans).toHaveLength(1);

    const fire = fireSpans[0];
    if (!fire) {
      throw new Error("expected a recorded continuation.delegate.fire span");
    }
    expect(fire.status).toBe("OK");
    expect(fire.ended).toBe(true);

    const dispatchChainId = dispatchSpans[0]?.attributes["chain.id"];
    expect(typeof dispatchChainId).toBe("string");
    expect(dispatchChainId as string).toMatch(UUIDV7_REGEX);
    // Trace stitches: fire.chain.id === dispatch.chain.id
    expect(fire.attributes["chain.id"]).toBe(dispatchChainId);
    expect(fire.attributes["delay.ms"]).toBe(1_000);
    expect(fire.attributes["delegate.delivery"]).toBe("timer");
    expect(typeof fire.attributes["delegate.mode"]).toBe("string");
    expect(typeof fire.attributes["fire.deferred_ms"]).toBe("number");
    // Loose floor: fake timers advance synchronously, so drift is small
    // but should be non-negative and bounded.
    const fireDeferredMs = fire.attributes["fire.deferred_ms"] as number;
    expect(fireDeferredMs).toBeGreaterThanOrEqual(0);
    expect(fireDeferredMs).toBeLessThan(1_000 + 5_000);
  });

  it("tool-delegate immediate dispatch emits exactly one `continuation.delegate.dispatch` with chain.id", async () => {
    vi.useFakeTimers();
    const { tracer, spans } = createRecordingTracer();
    setContinuationTracer(tracer);

    const sessionKey = "continuation-delegate-fire-tool";
    const run = createContinuationRun({ sessionKey });
    runEmbeddedPiAgentMock.mockImplementationOnce(async () => {
      enqueuePendingDelegate(sessionKey, {
        task: "poll PR #999 status",
        mode: "normal",
        traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      });
      return {
        payloads: [{ text: "Spawning a delegate to handle this." }],
        meta: { agentMeta: { usage: { input: 1, output: 1 } } },
      };
    });

    await runDelegateTurn(run, { [sessionKey]: run.sessionEntry });

    const dispatchSpans = spans.filter((s) => s.name === "continuation.delegate.dispatch");
    expect(dispatchSpans).toHaveLength(1);

    const dispatch = dispatchSpans[0];
    if (!dispatch) {
      throw new Error("expected a recorded continuation.delegate.dispatch span");
    }
    expect(dispatch.ended).toBe(true);

    const dispatchChainId = dispatch.attributes["chain.id"];
    expect(typeof dispatchChainId).toBe("string");
    expect(dispatchChainId as string).toMatch(UUIDV7_REGEX);
    expect(dispatch.attributes["delay.ms"]).toBe(0);
    expect(dispatch.attributes["delegate.delivery"]).toBe("immediate");
    expect(dispatch.attributes["delegate.mode"]).toBe("normal");
    expect(dispatch.traceparent).toBe("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
    expect(spawnSubagentDirectMock.mock.calls[0]?.[0]).toMatchObject({
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    });
  });

  it("tool-delegate immediate dispatch preserves singular targetSessionKey into spawned continuation run", async () => {
    const sessionKey = "continuation-delegate-targeted-tool";
    const targetSessionKey = "agent:main:test:channel:CHANNEL_A";
    const run = createContinuationRun({ sessionKey });
    runEmbeddedPiAgentMock.mockImplementationOnce(async () => {
      const tool = createContinueDelegateTool({ agentSessionKey: sessionKey });
      await tool.execute("call-targeted-delegate", {
        task: "return this shard to the named recipient",
        mode: "silent-wake",
        targetSessionKey,
      });
      return {
        payloads: [{ text: "Queued targeted delegate." }],
        meta: { agentMeta: { usage: { input: 1, output: 1 } } },
      };
    });

    await runDelegateTurn(run, { [sessionKey]: run.sessionEntry });

    expect(spawnSubagentDirectMock.mock.calls[0]?.[0]).toMatchObject({
      silentAnnounce: true,
      wakeOnReturn: true,
      continuationTargetSessionKey: targetSessionKey,
    });
  });

  it("reservation-missing path: timer fire emits `continuation.delegate.fire` AND sibling `continuation.disabled (reason=reservation.missing)` sharing chain.id", async () => {
    vi.useFakeTimers();
    const { tracer, spans } = createRecordingTracer();
    setContinuationTracer(tracer);

    const run = createContinuationRun({ sessionKey: "continuation-delegate-fire-resv-missing" });
    const sessionStore = { [run.sessionKey]: run.sessionEntry };
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Reply\n[[CONTINUE_DELEGATE: inspect logs +1s]]" }],
      meta: { agentMeta: { usage: { input: 1, output: 1 } } },
    });

    await runDelegateTurn(run, sessionStore);

    // Clear the reservation between arm and fire WITHOUT cancelling the
    // timer (which would call clearTimeout and prevent the callback). This
    // models the existing fire-time divergence: timer fires (wall-clock
    // truth) but `takeDelayedContinuationReservation` returns null because
    // some other path (compaction, explicit cancel via a different code
    // path, session teardown) already cleared the reservation.
    clearDelayedContinuationReservations(run.sessionKey);

    await vi.advanceTimersByTimeAsync(1_000);

    const fireSpans = spans.filter((s) => s.name === "continuation.delegate.fire");
    expect(fireSpans).toHaveLength(1);
    const fire = fireSpans[0];
    if (!fire) {
      throw new Error("expected a recorded continuation.delegate.fire span");
    }

    const reservationMissingSpans = spans.filter(
      (s) =>
        s.name === "continuation.disabled" &&
        s.attributes["disabled.reason"] === "reservation.missing",
    );
    expect(reservationMissingSpans).toHaveLength(1);
    const sibling = reservationMissingSpans[0];
    if (!sibling) {
      throw new Error("expected a reservation.missing continuation.disabled sibling");
    }

    // Both share chain.id — trace consumers can pair fire+disabled events.
    expect(fire.attributes["chain.id"]).toBeDefined();
    expect(sibling.attributes["chain.id"]).toBe(fire.attributes["chain.id"]);
    expect(sibling.attributes["signal.kind"]).toBe("bracket-delegate");
    expect(sibling.attributes["delegate.delivery"]).toBe("timer");
    expect(sibling.attributes["continuation.disabled"]).toBe(true);

    // No spawn happened on reservation-missing: the only tool-spawn paths
    // are `doSpawn` (bracket) → `spawnSubagentDirect`. Neither runs after
    // a cleared reservation.
    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
  });
});

// Pins the maturity contract on the tool-delegate consume path: a delegate
// returned from `consumePendingDelegates` has already passed its
// `flow.createdAt + delayMs` horizon, so the dispatch site must spawn it
// immediately. Re-arming a fresh `setTimeout(delayMs)` against the historical
// metadata charges the wait twice and drifts recipient drains by the original
// delay (e.g., `delaySeconds: 30` would fire at ~60s instead of ~30s).
describe("runReplyAgent :: matured consumed delegate spawns immediately", () => {
  it("matured consumed delegate fires on next dispatch without second full-delay wait", async () => {
    vi.useFakeTimers();
    const sessionKey = "continuation-delegate-matured-consumed-rearm";
    const run = createContinuationRun({ sessionKey });
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ack" }],
      meta: { agentMeta: { usage: { input: 1, output: 1 } } },
    });

    // Stage a delegate as if a prior turn had enqueued it via
    // `continue_delegate({ delaySeconds: 3 })`, then advance fake time past
    // its dueAt so `consumePendingDelegates` returns it as matured. The
    // delegate object carries `delayMs: 3_000` as historical metadata.
    enqueuePendingDelegate(sessionKey, {
      task: "matured-task",
      mode: "silent-wake",
      delayMs: 3_000,
    });
    await vi.advanceTimersByTimeAsync(3_001);

    await runDelegateTurn(run, { [run.sessionKey]: run.sessionEntry });

    // Without further timer advance: spawn must have already fired. Under
    // the buggy re-arm path, the consume site armed a fresh
    // `setTimeout(3_000)` and `spawnSubagentDirect` would still be pending,
    // making this assertion observe 0 calls.
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnSubagentDirectMock.mock.calls[0]?.[0] as {
      task?: string;
      silentAnnounce?: boolean;
      wakeOnReturn?: boolean;
    };
    expect(spawnArgs?.task).toContain("matured-task");
    expect(spawnArgs?.silentAnnounce).toBe(true);
    expect(spawnArgs?.wakeOnReturn).toBe(true);
  });
});
