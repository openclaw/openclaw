import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentHarnessPreflightError } from "../../agents/harness/errors.js";
import { createAgentLifecycleTerminalBackstop } from "../../auto-reply/reply/agent-lifecycle-terminal.js";
import { emitAgentEvent, getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import type { DedupeEntry } from "../server-shared.js";
import { setGatewayDedupeEntry, waitForAgentJob } from "./agent-job.js";

let runSequence = 0;

describe("waitForAgentJob settled execution", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
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
