import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { createAgentCommandLifecycle } from "../../agents/command/lifecycle.js";
import { AgentHarnessPreflightError } from "../../agents/harness/errors.js";
import { createAgentLifecycleTerminalBackstop } from "../../auto-reply/reply/agent-lifecycle-terminal.js";
import { emitAgentEvent, getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import type { DedupeEntry } from "../server-shared.js";
import { getAgentJobSession, setGatewayDedupeEntry, waitForAgentJob } from "./agent-job.js";
import type { AgentJobSession } from "./types.js";

let runSequence = 0;
const originalSession = {
  sessionKey: "agent:main:original",
  sessionId: "original-session",
  agentId: "main",
};
const settledTiming = { phase: "end", executionSettled: true, startedAt: 100, endedAt: 200 };
const providerTimeout = {
  stopReason: "timeout",
  timeoutPhase: "provider",
  providerStarted: true,
} as const;
type Source = "agent" | "chat";
type DedupeOptions = Pick<
  Parameters<typeof setGatewayDedupeEntry>[0],
  "session" | "startNewAttempt"
> & {
  ts?: number;
  ok?: boolean;
};

function createJob(prefix: string) {
  const runId = `${prefix}-${runSequence++}`;
  const dedupe = new Map<string, DedupeEntry>();
  const wait = (source?: Source, timeoutMs = 0) => waitForAgentJob({ runId, source, timeoutMs });
  return {
    runId,
    dedupe,
    wait,
    emit: (data: Record<string, unknown>, session?: Partial<AgentJobSession>) =>
      emitAgentEvent({ runId, stream: "lifecycle", data, ...session }),
    publish(source: Source, payload: Record<string, unknown>, options: DedupeOptions = {}) {
      const { ts = Date.now(), ok = true, ...binding } = options;
      setGatewayDedupeEntry({
        dedupe,
        key: `${source}:${runId}`,
        entry: { ts, ok, payload: { runId, ...payload } },
        ...binding,
      });
    },
    expect: (expected: unknown, source?: Source) =>
      expect(wait(source)).resolves.toMatchObject(expected),
  };
}

describe("waitForAgentJob settled execution", () => {
  it("observes completed hidden refreshes without treating acceptance as completion", async () => {
    const job = createJob("progress-card-refresh:completed");
    for (const status of ["accepted", "completed"] as const) {
      job.publish("chat", { status });
      const result = await job.wait("chat");
      if (status === "accepted") {
        expect(result).toBeNull();
      } else {
        expect(result).toMatchObject({ status: "ok" });
      }
    }
  });

  it("normalizes an outer timeout after yield before publishing the wait snapshot", async () => {
    const job = createJob("outer-timeout-after-yield");
    const waiter = job.wait(undefined, 60_000);
    const controller = new AbortController();
    const lifecycle = createAgentCommandLifecycle({
      runId: job.runId,
      lifecycleGeneration: getAgentEventLifecycleGeneration,
      startedAt: 100,
      abortSignal: controller.signal,
      state: {
        currentTurnUserMessagePersisted: true,
        lifecycleFinishing: false,
        lifecycleEnded: false,
      },
    });
    const terminal = {
      metadata: { yielded: true, aborted: false },
      outcome: buildAgentRunTerminalOutcome({
        status: "ok",
        stopReason: "end_turn",
        livenessState: "paused",
      }),
    };
    controller.abort(new DOMException("outer deadline", "TimeoutError"));
    lifecycle.emitEnd(terminal);
    try {
      const expected = { status: "timeout", stopReason: "timeout", yielded: true } as const;
      await expect(waiter).resolves.toMatchObject(expected);
      await job.expect(expected);
    } finally {
      await vi.advanceTimersByTimeAsync(60_000);
      await waiter;
    }
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each([
    ["agent", true, "ok", { disposition: "visible", text: "Recorded reply" }],
    ["agent", false, "ok", { disposition: "visible", text: "Recorded reply" }],
    ["chat", true, "error", { disposition: "visible", text: "Recorded reply" }],
    ["chat", true, "timeout", { disposition: "visible", text: "Recorded reply" }],
    ["chat", false, "ok", { disposition: "silent" }],
    ["chat", false, "ok", { disposition: "empty", code: "message-tool-not-called" }],
  ] as const)(
    "keeps %s timing and reply evidence (lifecycle first=%s, status=%s, reply=%j)",
    async (source, lifecycleFirst, status, terminalReply) => {
      const job = createJob("execution-timing");
      const { runId, dedupe } = job;
      const publishedAt = Date.now();
      const entry = { ts: publishedAt, ok: status === "ok", payload: { runId, status } };
      const terminalReceipt = {
        runId,
        sessionId: "session-a",
        turnId: "turn-a",
        requested: { provider: "test", model: "test-model" },
        effective: { provider: "test", model: "test-model", responseModel: "test-model" },
        successfulToolNames: [],
        rerouted: false,
        terminalDisposition: "visible",
      };
      const waiter = lifecycleFirst ? job.wait(source, 60_000) : undefined;
      const recordLifecycle = () => job.emit({ ...settledTiming, terminalReply, terminalReceipt });
      if (lifecycleFirst) {
        recordLifecycle();
        await expect(job.wait(source)).resolves.toBeNull();
      }
      setGatewayDedupeEntry({ dedupe, key: `${source}:${runId}`, entry });
      if (!lifecycleFirst) {
        recordLifecycle();
      }
      const expected = {
        status,
        startedAt: 100,
        endedAt: status === "ok" ? 200 : publishedAt,
        terminalReply,
        terminalReceipt,
      };
      if (waiter) {
        await expect(waiter).resolves.toMatchObject(expected);
      }
      for (const selectedSource of [undefined, source]) {
        await job.expect(expected, selectedSource);
      }
      expect(dedupe.get(`${source}:${runId}`)).toBe(entry);
      await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
      await job.expect({ endedAt: expected.endedAt }, source);
      await vi.advanceTimersByTimeAsync(2);
      await expect(job.wait(source)).resolves.toBeNull();
    },
  );

  it.each([
    "new attempt",
    "different session",
    "different generation",
    "expired lifecycle",
  ] as const)("does not borrow timing from a %s", async (change) => {
    const job = createJob("execution-timing-fence");
    const original = {
      agentId: "main",
      sessionKey: "agent:main:original",
      sessionId: "original",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
    };
    job.emit(settledTiming, original);
    if (change === "new attempt") {
      job.publish("agent", { status: "accepted" }, { startNewAttempt: true });
    } else if (change === "expired lifecycle") {
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    }
    const session =
      change === "different session"
        ? { ...original, sessionKey: "agent:main:replacement", sessionId: "replacement" }
        : change === "different generation"
          ? { ...original, lifecycleGeneration: "replacement-generation" }
          : original;
    const publishedAt = Date.now();
    job.publish("agent", { status: "ok" }, { session, ts: publishedAt });
    await job.expect({ status: "ok", startedAt: undefined, endedAt: publishedAt }, "agent");
  });

  it.each([
    { status: "timeout", ...providerTimeout },
    { status: "error", stopReason: "rpc" },
  ] as const)("preserves lifecycle $stopReason after the chat barrier", async (outcome) => {
    for (const lifecycleFirst of [true, false]) {
      const job = createJob("chat-sticky-reply");
      const { runId } = job;
      const terminalReply = { disposition: "visible", text: "Partial output" } as const;
      const recordLifecycle = () =>
        job.emit(
          { phase: "end", executionSettled: true, endedAt: 100, ...outcome, terminalReply },
          originalSession,
        );
      const waiter = lifecycleFirst ? job.wait("chat", 60_000) : undefined;
      if (lifecycleFirst) {
        recordLifecycle();
      }
      registerAgentRunContext(runId, {
        sessionKey: "agent:main:replacement",
        sessionId: "replacement-session",
        agentId: "main",
      });
      try {
        job.publish("chat", { status: "ok", endedAt: 200 });
      } finally {
        clearAgentRunContext(runId);
      }
      if (!lifecycleFirst) {
        recordLifecycle();
      }
      if (waiter) {
        await expect(waiter).resolves.toMatchObject({ ...outcome, terminalReply });
      }
      expect(getAgentJobSession(runId)).toMatchObject({
        sessionKey: "agent:main:original",
        sessionId: "original-session",
      });
      await job.expect({ ...outcome, terminalReply }, "chat");
    }
  });

  it.each(["ok", "error", "timeout"] as const)(
    "preserves yielded execution only when chat settles successfully: %s",
    async (status) => {
      const job = createJob("chat-yielded-execution");
      await job.wait("chat");
      job.emit({ phase: "start", startedAt: 100 });
      job.emit({ ...settledTiming, yielded: true, livenessState: "paused" });
      await expect(job.wait("chat")).resolves.toBeNull();
      job.publish("chat", { status, startedAt: 100, endedAt: 300 }, { ok: status === "ok" });
      await job.expect(
        {
          status,
          endedAt: 300,
          yielded: status === "ok" ? true : undefined,
          livenessState: status === "ok" ? "paused" : undefined,
        },
        "chat",
      );
    },
  );

  it.each(["different session", "unbound"] as const)(
    "keeps companion evidence with its selected session when the other producer is %s",
    async (otherBinding) => {
      const job = createJob("terminal-companion-binding");
      const session = {
        ...originalSession,
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
      };
      job.publish(
        "agent",
        { status: "timeout", stopReason: "timeout", timeoutPhase: "provider" },
        { session, ts: 100, ok: false },
      );
      job.publish(
        "chat",
        {
          status: "ok",
          terminalReply: { disposition: "visible", text: "Other producer's reply" },
        },
        {
          ts: 200,
          session:
            otherBinding === "unbound"
              ? undefined
              : { ...session, sessionKey: "agent:main:other", sessionId: "other-session" },
        },
      );
      const selected = await job.wait();
      expect(selected).toMatchObject({ status: "timeout", session });
      expect(selected?.terminalReply).toBeUndefined();
    },
  );

  it.each(["live registration", "selected cache entry"] as const)(
    "keeps terminal session facts when a later attempt replaces the %s",
    async (replacement) => {
      const job = createJob("terminal-session-binding");
      const { runId } = job;
      const original = {
        ...originalSession,
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
      };
      const successor = {
        ...original,
        sessionKey: "agent:main:successor",
        sessionId: "successor-session",
      };
      const session = { ...original };
      registerAgentRunContext(runId, replacement === "live registration" ? successor : original);
      try {
        job.publish("agent", { status: "ok", endedAt: 100 }, { session });
        if (replacement === "live registration") {
          expect(getAgentJobSession(runId)).toEqual(original);
        }
        const selected = job.wait();
        if (replacement === "selected cache entry") {
          registerAgentRunContext(runId, successor);
          job.publish("agent", { status: "accepted" }, { startNewAttempt: true });
          job.publish("agent", { status: "ok", endedAt: 200 }, { session: successor });
          expect(getAgentJobSession(runId)).toEqual(successor);
        }
        await expect(selected).resolves.toMatchObject({
          status: "ok",
          endedAt: 100,
          session: original,
        });
      } finally {
        clearAgentRunContext(runId);
      }
    },
  );

  it.each([
    [
      "preflight failure",
      new AgentHarnessPreflightError("execution preparation failed"),
      { status: "error", error: "execution preparation failed" },
    ],
    [
      "explicit cancellation",
      new Error("execution cancelled"),
      { status: "error", stopReason: "rpc" },
      { aborted: true, stopReason: "rpc" },
    ],
    [
      "bare abort from a settled backend",
      { meta: { aborted: true } },
      { status: "error", stopReason: "aborted" },
    ],
    [
      "provider timeout",
      { meta: { aborted: true, ...providerTimeout } },
      { status: "timeout", stopReason: "timeout", timeoutPhase: "provider" },
    ],
    ["yielded execution", { meta: { yielded: true } }, { status: "ok", yielded: true }],
  ] as const)(
    "publishes %s without retry grace",
    async (_label, result, expected, termination = {}) => {
      const phase = result instanceof Error ? "error" : "end";
      const job = createJob("settled-execution");
      const { runId } = job;
      const waiter = job.wait(undefined, 60_000);
      const lifecycle = createAgentLifecycleTerminalBackstop({
        runId,
        startedAt: 1_000,
        getLifecycleGeneration: getAgentEventLifecycleGeneration,
        resolveTerminationFields: () => termination,
      });
      job.emit({ phase: "start", startedAt: 1_000 });
      try {
        lifecycle.capture(phase, result);
        await expect(job.wait()).resolves.toBeNull();
        lifecycle.emit(phase, result);
        // Assert before advancing clocks: an active waiter and a new reader must
        // observe the producer's final result, not its eventual deadline fallback.
        await job.expect(expected);
        await expect(waiter).resolves.toMatchObject(expected);
      } finally {
        await vi.advanceTimersByTimeAsync(60_000);
        await waiter;
      }
    },
  );
});
