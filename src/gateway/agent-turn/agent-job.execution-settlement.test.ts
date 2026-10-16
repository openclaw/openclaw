import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { createAgentCommandLifecycle } from "../../agents/command/lifecycle.js";
import { AgentHarnessPreflightError } from "../../agents/harness/errors.js";
import { createAgentLifecycleTerminalBackstop } from "../../auto-reply/reply/agent-lifecycle-terminal.js";
import { emitAgentEvent, getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import type { DedupeEntry } from "../server-shared.js";
import { getAgentJobSession, setGatewayDedupeEntry, waitForAgentJob } from "./agent-job.js";

let runSequence = 0;
const originalSession = {
  sessionKey: "agent:main:original",
  sessionId: "original-session",
  agentId: "main",
};
type DedupeOptions = Partial<Omit<Parameters<typeof setGatewayDedupeEntry>[0], "key" | "entry">> & {
  ts?: number;
  ok?: boolean;
};

function publish(
  runId: string,
  source: "agent" | "chat",
  payload: Record<string, unknown>,
  {
    ts = Date.now(),
    ok = true,
    dedupe = new Map<string, DedupeEntry>(),
    ...options
  }: DedupeOptions = {},
) {
  setGatewayDedupeEntry({
    dedupe,
    key: `${source}:${runId}`,
    entry: { ts, ok, payload: { runId, ...payload } },
    ...options,
  });
}

function emitLifecycle(runId: string, data: Record<string, unknown>) {
  emitAgentEvent({ runId, stream: "lifecycle", data });
}

describe("waitForAgentJob settled execution", () => {
  it("observes completed hidden refreshes without treating acceptance as completion", async () => {
    const runId = `progress-card-refresh:completed-${runSequence++}`;
    const dedupe = new Map<string, DedupeEntry>();
    for (const status of ["accepted", "completed"] as const) {
      publish(runId, "chat", { status }, { dedupe });
      const result = await waitForAgentJob({ runId, source: "chat", timeoutMs: 0 });
      if (status === "accepted") {
        expect(result).toBeNull();
      } else {
        expect(result).toMatchObject({ status: "ok" });
      }
    }
  });

  it("normalizes an outer timeout after yield before publishing the wait snapshot", async () => {
    const runId = `outer-timeout-after-yield-${runSequence++}`;
    const waiter = waitForAgentJob({ runId, timeoutMs: 60_000 });
    const controller = new AbortController();
    const lifecycle = createAgentCommandLifecycle({
      runId,
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
      await expect(waiter).resolves.toMatchObject({
        status: "timeout",
        stopReason: "timeout",
        yielded: true,
      });
      await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toMatchObject({
        status: "timeout",
        stopReason: "timeout",
        yielded: true,
      });
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
      const runId = `execution-timing-${runSequence++}`;
      const dedupe = new Map<string, DedupeEntry>();
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
      const waiter = lifecycleFirst
        ? waitForAgentJob({ runId, source, timeoutMs: 60_000 })
        : undefined;
      const recordLifecycle = () =>
        emitLifecycle(runId, {
          phase: "end",
          executionSettled: true,
          startedAt: 100,
          endedAt: 200,
          terminalReply,
          terminalReceipt,
        });
      if (lifecycleFirst) {
        recordLifecycle();
        await expect(waitForAgentJob({ runId, source, timeoutMs: 0 })).resolves.toBeNull();
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
        await expect(
          waitForAgentJob({ runId, source: selectedSource, timeoutMs: 0 }),
        ).resolves.toMatchObject(expected);
      }
      expect(dedupe.get(`${source}:${runId}`)).toBe(entry);
      await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
      await expect(waitForAgentJob({ runId, source, timeoutMs: 0 })).resolves.toMatchObject({
        endedAt: expected.endedAt,
      });
      await vi.advanceTimersByTimeAsync(2);
      await expect(waitForAgentJob({ runId, source, timeoutMs: 0 })).resolves.toBeNull();
    },
  );

  it.each([
    "new attempt",
    "different session",
    "different generation",
    "expired lifecycle",
  ] as const)("does not borrow timing from a %s", async (change) => {
    const runId = `execution-timing-fence-${runSequence++}`;
    const dedupe = new Map<string, DedupeEntry>();
    const original = {
      agentId: "main",
      sessionKey: "agent:main:original",
      sessionId: "original",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
    };
    emitAgentEvent({
      runId,
      ...original,
      stream: "lifecycle",
      data: { phase: "end", executionSettled: true, startedAt: 100, endedAt: 200 },
    });
    if (change === "new attempt") {
      publish(runId, "agent", { status: "accepted" }, { dedupe, startNewAttempt: true });
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
    publish(runId, "agent", { status: "ok" }, { dedupe, session, ts: publishedAt });
    await expect(waitForAgentJob({ runId, source: "agent", timeoutMs: 0 })).resolves.toMatchObject({
      status: "ok",
      startedAt: undefined,
      endedAt: publishedAt,
    });
  });

  it.each([
    { status: "timeout", stopReason: "timeout", timeoutPhase: "provider", providerStarted: true },
    { status: "error", stopReason: "rpc" },
  ] as const)("preserves lifecycle $stopReason after the chat barrier", async (outcome) => {
    for (const lifecycleFirst of [true, false]) {
      const runId = `chat-sticky-reply-${runSequence++}`;
      const terminalReply = { disposition: "visible", text: "Partial output" } as const;
      const recordLifecycle = () =>
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          ...originalSession,
          data: { phase: "end", executionSettled: true, endedAt: 100, ...outcome, terminalReply },
        });
      const waiter = lifecycleFirst
        ? waitForAgentJob({ runId, source: "chat", timeoutMs: 60_000 })
        : undefined;
      if (lifecycleFirst) {
        recordLifecycle();
      }
      registerAgentRunContext(runId, {
        sessionKey: "agent:main:replacement",
        sessionId: "replacement-session",
        agentId: "main",
      });
      try {
        publish(runId, "chat", { status: "ok", endedAt: 200 });
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
      await expect(waitForAgentJob({ runId, source: "chat", timeoutMs: 0 })).resolves.toMatchObject(
        {
          ...outcome,
          terminalReply,
        },
      );
    }
  });

  it.each(["ok", "error", "timeout"] as const)(
    "preserves yielded execution only when chat settles successfully: %s",
    async (status) => {
      const runId = `chat-yielded-execution-${runSequence++}`;
      await waitForAgentJob({ runId, source: "chat", timeoutMs: 0 });
      emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "start", startedAt: 100 } });
      emitLifecycle(runId, {
        phase: "end",
        startedAt: 100,
        endedAt: 200,
        yielded: true,
        livenessState: "paused",
        executionSettled: true,
      });
      await expect(waitForAgentJob({ runId, source: "chat", timeoutMs: 0 })).resolves.toBeNull();
      publish(runId, "chat", { status, startedAt: 100, endedAt: 300 }, { ok: status === "ok" });
      await expect(waitForAgentJob({ runId, source: "chat", timeoutMs: 0 })).resolves.toMatchObject(
        {
          status,
          endedAt: 300,
          yielded: status === "ok" ? true : undefined,
          livenessState: status === "ok" ? "paused" : undefined,
        },
      );
    },
  );

  it.each(["different session", "unbound"] as const)(
    "keeps companion evidence with its selected session when the other producer is %s",
    async (otherBinding) => {
      const runId = `terminal-companion-binding-${runSequence++}`;
      const session = {
        ...originalSession,
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
      };
      const dedupe = new Map<string, DedupeEntry>();
      publish(
        runId,
        "agent",
        { status: "timeout", stopReason: "timeout", timeoutPhase: "provider" },
        { dedupe, session, ts: 100, ok: false },
      );
      publish(
        runId,
        "chat",
        {
          status: "ok",
          terminalReply: { disposition: "visible", text: "Other producer's reply" },
        },
        {
          dedupe,
          ts: 200,
          session:
            otherBinding === "unbound"
              ? undefined
              : { ...session, sessionKey: "agent:main:other", sessionId: "other-session" },
        },
      );
      const selected = await waitForAgentJob({ runId, timeoutMs: 0 });
      expect(selected).toMatchObject({ status: "timeout", session });
      expect(selected?.terminalReply).toBeUndefined();
    },
  );

  it.each(["live registration", "selected cache entry"] as const)(
    "keeps terminal session facts when a later attempt replaces the %s",
    async (replacement) => {
      const runId = `terminal-session-binding-${runSequence++}`;
      const original = {
        ...originalSession,
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
      };
      const successor = {
        ...original,
        sessionKey: "agent:main:successor",
        sessionId: "successor-session",
      };
      const dedupe = new Map<string, DedupeEntry>();
      const session = { ...original };
      registerAgentRunContext(runId, replacement === "live registration" ? successor : original);
      try {
        publish(runId, "agent", { status: "ok", endedAt: 100 }, { dedupe, session });
        if (replacement === "live registration") {
          expect(getAgentJobSession(runId)).toEqual(original);
        }
        const selected = waitForAgentJob({ runId, timeoutMs: 0 });
        if (replacement === "selected cache entry") {
          registerAgentRunContext(runId, successor);
          publish(runId, "agent", { status: "accepted" }, { dedupe, startNewAttempt: true });
          publish(runId, "agent", { status: "ok", endedAt: 200 }, { dedupe, session: successor });
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
      "error",
      new AgentHarnessPreflightError("execution preparation failed"),
      {},
      { status: "error", error: "execution preparation failed" },
    ],
    [
      "explicit cancellation",
      "error",
      new Error("execution cancelled"),
      { aborted: true, stopReason: "rpc" },
      { status: "error", stopReason: "rpc" },
    ],
    [
      "bare abort from a settled backend",
      "end",
      { meta: { aborted: true } },
      {},
      { status: "error", stopReason: "aborted" },
    ],
    [
      "provider timeout",
      "end",
      {
        meta: {
          aborted: true,
          stopReason: "timeout",
          timeoutPhase: "provider",
          providerStarted: true,
        },
      },
      {},
      { status: "timeout", stopReason: "timeout", timeoutPhase: "provider" },
    ],
    ["yielded execution", "end", { meta: { yielded: true } }, {}, { status: "ok", yielded: true }],
  ] as const)(
    "publishes %s without retry grace",
    async (_label, phase, result, termination, expected) => {
      const runId = `settled-execution-${runSequence++}`;
      const waiter = waitForAgentJob({ runId, timeoutMs: 60_000 });
      const lifecycle = createAgentLifecycleTerminalBackstop({
        runId,
        startedAt: 1_000,
        getLifecycleGeneration: getAgentEventLifecycleGeneration,
        resolveTerminationFields: () => termination,
      });
      emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "start", startedAt: 1_000 } });
      try {
        lifecycle.capture(phase, result);
        await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toBeNull();
        lifecycle.emit(phase, result);
        // Assert before advancing clocks: an active waiter and a new reader must
        // observe the producer's final result, not its eventual deadline fallback.
        await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toMatchObject(expected);
        await expect(waiter).resolves.toMatchObject(expected);
      } finally {
        await vi.advanceTimersByTimeAsync(60_000);
        await waiter;
      }
    },
  );
});
