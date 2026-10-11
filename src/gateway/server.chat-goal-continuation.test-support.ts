import { expect, it, type MockInstance } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import type { runEmbeddedAgent as executeEmbeddedAgent } from "../agents/embedded-agent.js";
import { loadSessionEntry, patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import type { RespondFn } from "./server-methods/types.js";

/** Reuse the suite's admission, queue and reply owners; only provider execution is simulated. */
export function registerGoalAutomaticContinuationCases(
  scope: () => { agentId: string; sessionKey: string; sessionId: string; storePath: string },
  runEmbeddedAgent: MockInstance<typeof executeEmbeddedAgent>,
  rpc: (
    method: "chat.send" | "sessions.abort",
    params: Record<string, unknown>,
  ) => Promise<MockInstance<RespondFn>>,
  goalStart: (message: string) => Record<string, unknown>,
  userMessages: () => readonly unknown[],
) {
  it("nudges consecutive normal final turns until the same Goal is complete", async () => {
    const completed = createDeferred();
    runEmbeddedAgent.mockImplementation(async (params) => {
      const calls = runEmbeddedAgent.mock.calls.length;
      if (calls === 3) {
        await patchSessionEntryCore(scope(), (entry) => ({
          goal: entry.goal ? { ...entry.goal, status: "complete" } : undefined,
        }));
        completed.resolve();
      }
      return {
        payloads: [{ text: calls === 3 ? "Verified the goal." : "More work remains." }],
        meta: {
          durationMs: 0,
          stopReason: "end_turn",
          agentMeta: {
            sessionId: params.sessionId,
            provider: "test",
            model: "test",
            usage: { input: 1, output: 1 },
          },
        },
      };
    });
    const started = await rpc("chat.send", goalStart("Finish a three-turn checklist"));
    expect(started.mock.calls[0]?.[0]).toBe(true);
    await completed.promise;
    const drained = await waitForGatewayActiveWork(30_000);
    expect(drained.drained).toBe(true);
    expect(runEmbeddedAgent).toHaveBeenCalledTimes(3);
    expect(runEmbeddedAgent.mock.calls[1]?.[0].prompt).toContain("Advance");
    expect(runEmbeddedAgent.mock.calls[2]?.[0].prompt).toContain("Advance");
    expect(userMessages()).toHaveLength(1);
    expect(loadSessionEntry(scope())?.goal?.status).toBe("complete");
  });

  it("stops automatic goal pursuit when the operator stops a continuation", async () => {
    const { sessionKey } = scope();
    const secondStarted = createDeferred();
    const released = createDeferred();
    let continuationSignal: AbortSignal | undefined;
    let continuationRunId: string | undefined;
    runEmbeddedAgent.mockImplementation(async (params) => {
      const second = runEmbeddedAgent.mock.calls.length === 2;
      if (second) {
        continuationRunId = params.runId;
        const runtimeAbort = new AbortController();
        continuationSignal = params.abortSignal
          ? AbortSignal.any([params.abortSignal, runtimeAbort.signal])
          : runtimeAbort.signal;
        const abort = () => {
          runtimeAbort.abort();
          released.resolve();
        };
        // The model is mocked; preserve the runtime's real Stop registration boundary.
        const backend = {
          kind: "embedded" as const,
          runId: params.runId,
          cancel: abort,
          abort,
          isStreaming: () => !runtimeAbort.signal.aborted,
          isAborted: () => runtimeAbort.signal.aborted,
          isCompacting: () => false,
          queueMessage: async () => {},
        };
        params.replyOperation?.attachBackend(backend);
        setActiveEmbeddedRun(params.sessionId, backend, sessionKey, params.sessionFile, "main");
        secondStarted.resolve();
        try {
          await released.promise;
        } finally {
          clearActiveEmbeddedRun(params.sessionId, backend, sessionKey, params.sessionFile);
          params.replyOperation?.detachBackend(backend);
        }
      }
      const aborted = continuationSignal?.aborted === true;
      return {
        payloads: aborted ? [] : [{ text: "The goal is not complete yet." }],
        meta: {
          durationMs: 0,
          stopReason: aborted ? "aborted" : "end_turn",
          aborted,
          agentMeta: {
            sessionId: params.sessionId,
            provider: "test",
            model: "test",
            usage: { input: 1, output: 1 },
          },
        },
      };
    });
    const started = await rpc("chat.send", goalStart("Keep working until stopped"));
    expect(started.mock.calls[0]?.[0]).toBe(true);
    try {
      await secondStarted.promise;
      const stopped = await rpc("sessions.abort", { key: sessionKey, runId: continuationRunId });
      expect(stopped.mock.calls[0]?.[0]).toBe(true);
      expect(continuationSignal?.aborted).toBe(true);
    } finally {
      if (continuationSignal?.aborted !== true) {
        await patchSessionEntryCore(scope(), (entry) => ({
          goal: entry.goal ? { ...entry.goal, status: "paused" } : undefined,
        }));
      }
      released.resolve();
    }
    const drained = await waitForGatewayActiveWork(30_000);
    expect(drained.drained).toBe(true);
    expect(runEmbeddedAgent).toHaveBeenCalledTimes(2);
    expect(loadSessionEntry(scope())?.goal?.status).toBe("active");
  });
}
