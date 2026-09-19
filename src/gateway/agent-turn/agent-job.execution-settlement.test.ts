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

describe("waitForAgentJob settled execution", () => {
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

  it.each(["ok", "error", "timeout"] as const)(
    "returns recorded reply evidence only after chat settles: %s",
    async (status) => {
      const runId = `chat-recorded-reply-${runSequence++}`;
      const terminalReply = { disposition: "visible", text: "The requested answer" } as const;
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
      const waiter = waitForAgentJob({ runId, source: "chat", timeoutMs: 60_000 });
      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "end", executionSettled: true, terminalReply, terminalReceipt },
      });
      // Runtime completion must not release the chat delivery barrier.
      await expect(waitForAgentJob({ runId, source: "chat", timeoutMs: 0 })).resolves.toBeNull();
      setGatewayDedupeEntry({
        dedupe: new Map<string, DedupeEntry>(),
        key: `chat:${runId}`,
        entry: { ts: Date.now(), ok: status === "ok", payload: { runId, status } },
      });
      await expect(waiter).resolves.toMatchObject({ status, terminalReply, terminalReceipt });
      await expect(waitForAgentJob({ runId, source: "chat", timeoutMs: 0 })).resolves.toMatchObject(
        {
          status,
          terminalReply,
          terminalReceipt,
        },
      );
    },
  );

  it.each([
    { disposition: "visible", text: "Recorded reply" },
    { disposition: "silent" },
    { disposition: "empty", code: "message-tool-not-called" },
  ] as const)("preserves late lifecycle reply disposition: $disposition", async (terminalReply) => {
    const runId = `chat-late-reply-${runSequence++}`;
    setGatewayDedupeEntry({
      dedupe: new Map<string, DedupeEntry>(),
      key: `chat:${runId}`,
      entry: { ts: Date.now(), ok: true, payload: { runId, status: "ok" } },
    });
    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: {
        phase: "end",
        executionSettled: true,
        terminalReply,
      },
    });
    await expect(waitForAgentJob({ runId, source: "chat", timeoutMs: 0 })).resolves.toMatchObject({
      status: "ok",
      terminalReply,
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
          sessionKey: "agent:main:original",
          sessionId: "original-session",
          agentId: "main",
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
        setGatewayDedupeEntry({
          dedupe: new Map<string, DedupeEntry>(),
          key: `chat:${runId}`,
          entry: { ts: Date.now(), ok: true, payload: { runId, status: "ok", endedAt: 200 } },
        });
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
      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: {
          phase: "end",
          startedAt: 100,
          endedAt: 200,
          yielded: true,
          livenessState: "paused",
          executionSettled: true,
        },
      });
      await expect(waitForAgentJob({ runId, source: "chat", timeoutMs: 0 })).resolves.toBeNull();
      setGatewayDedupeEntry({
        dedupe: new Map<string, DedupeEntry>(),
        key: `chat:${runId}`,
        entry: {
          ts: Date.now(),
          ok: status === "ok",
          payload: { runId, status, startedAt: 100, endedAt: 300 },
        },
      });
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
        sessionKey: "agent:main:original",
        sessionId: "original-session",
        agentId: "main",
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
      };
      const dedupe = new Map<string, DedupeEntry>();
      setGatewayDedupeEntry({
        dedupe,
        key: `agent:${runId}`,
        session,
        entry: {
          ts: 100,
          ok: false,
          payload: { runId, status: "timeout", stopReason: "timeout", timeoutPhase: "provider" },
        },
      });
      setGatewayDedupeEntry({
        dedupe,
        key: `chat:${runId}`,
        session:
          otherBinding === "unbound"
            ? undefined
            : { ...session, sessionKey: "agent:main:other", sessionId: "other-session" },
        entry: {
          ts: 200,
          ok: true,
          payload: {
            runId,
            status: "ok",
            terminalReply: { disposition: "visible", text: "Other producer's reply" },
          },
        },
      });
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
        sessionKey: "agent:main:original",
        sessionId: "original-session",
        agentId: "main",
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
      };
      const successor = {
        ...original,
        sessionKey: "agent:main:successor",
        sessionId: "successor-session",
      };
      const dedupe = new Map<string, DedupeEntry>();
      const key = `agent:${runId}`;
      const session = { ...original };
      registerAgentRunContext(runId, replacement === "live registration" ? successor : original);
      try {
        setGatewayDedupeEntry({
          dedupe,
          key,
          session,
          entry: { ts: Date.now(), ok: true, payload: { runId, status: "ok", endedAt: 100 } },
        });
        if (replacement === "live registration") {
          expect(getAgentJobSession(runId)).toEqual(original);
        }
        const selected = waitForAgentJob({ runId, timeoutMs: 0 });
        if (replacement === "selected cache entry") {
          registerAgentRunContext(runId, successor);
          setGatewayDedupeEntry({
            dedupe,
            key,
            startNewAttempt: true,
            entry: { ts: Date.now(), ok: true, payload: { runId, status: "accepted" } },
          });
          setGatewayDedupeEntry({
            dedupe,
            key,
            session: successor,
            entry: { ts: Date.now(), ok: true, payload: { runId, status: "ok", endedAt: 200 } },
          });
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
    {
      label: "preflight failure",
      phase: "error",
      result: new AgentHarnessPreflightError("execution preparation failed"),
      termination: {},
      expected: { status: "error", error: "execution preparation failed" },
    },
    {
      label: "explicit cancellation",
      phase: "error",
      result: new Error("execution cancelled"),
      termination: { aborted: true, stopReason: "rpc" },
      expected: { status: "error", stopReason: "rpc" },
    },
    {
      label: "bare abort from a settled backend",
      phase: "end",
      result: { meta: { aborted: true } },
      termination: {},
      expected: { status: "error", stopReason: "aborted" },
    },
    {
      label: "provider timeout",
      phase: "end",
      result: {
        meta: {
          aborted: true,
          stopReason: "timeout",
          timeoutPhase: "provider",
          providerStarted: true,
        },
      },
      termination: {},
      expected: { status: "timeout", stopReason: "timeout", timeoutPhase: "provider" },
    },
    {
      label: "yielded execution",
      phase: "end",
      result: { meta: { yielded: true } },
      termination: {},
      expected: { status: "ok", yielded: true },
    },
  ] as const)(
    "publishes $label without retry grace",
    async ({ phase, result, termination, expected }) => {
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
