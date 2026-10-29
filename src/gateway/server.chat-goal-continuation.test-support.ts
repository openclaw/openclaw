import { expect, it, type MockInstance } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as runs from "../agents/embedded-agent-runner/runs.js";
import type { runEmbeddedAgent as executeEmbeddedAgent } from "../agents/embedded-agent.js";
import { loadSessionEntry, patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import type { RespondFn } from "./server-methods/types.js";

export function registerGoalAutomaticContinuationCases(
  scope: () => { agentId: string; sessionKey: string; sessionId: string; storePath: string },
  runEmbeddedAgent: MockInstance<typeof executeEmbeddedAgent>,
  rpc: (
    method: "chat.send" | "sessions.abort" | "sessions.goal.update",
    params: Record<string, unknown>,
  ) => Promise<MockInstance<RespondFn>>,
  goalStart: (message: string) => Record<string, unknown>,
  userMessages: () => readonly unknown[],
) {
  const result = (sessionId: string, aborted?: boolean) => ({
    payloads: aborted ? [] : [{ text: "More work remains." }],
    meta: {
      durationMs: 0,
      stopReason: aborted ? "aborted" : "end_turn",
      ...(aborted === undefined ? {} : { aborted }),
      agentMeta: { sessionId, provider: "test", model: "test", usage: { input: 1, output: 1 } },
    },
  });
  const expectDrained = async () =>
    expect((await waitForGatewayActiveWork(30_000)).drained).toBe(true);
  const setGoalStatus = (status: "complete" | "paused") =>
    patchSessionEntryCore(scope(), (entry) => ({
      goal: entry.goal ? { ...entry.goal, status } : undefined,
    }));
  const start = async (message: string) =>
    expect((await rpc("chat.send", goalStart(message))).mock.calls[0]?.[0]).toBe(true);
  it("nudges consecutive normal final turns until the same Goal is complete", async () => {
    const completed = createDeferred();
    runEmbeddedAgent.mockImplementation(async (params) => {
      const calls = runEmbeddedAgent.mock.calls.length;
      if (calls === 3) {
        await setGoalStatus("complete");
        completed.resolve();
      }
      return result(params.sessionId);
    });
    await start("Finish a three-turn checklist");
    await completed.promise;
    await expectDrained();
    expect(runEmbeddedAgent).toHaveBeenCalledTimes(3);
    expect(runEmbeddedAgent.mock.calls[1]?.[0].prompt).toContain("Advance");
    expect(runEmbeddedAgent.mock.calls[2]?.[0].prompt).toContain("Advance");
    expect(userMessages()).toHaveLength(1);
    expect(loadSessionEntry(scope())?.goal).toMatchObject({
      status: "complete",
      continuationTurns: 2,
    });
  });

  it("stops automatic pursuit and resumes the same Goal once after the stopped run settles", async () => {
    const { sessionKey } = scope();
    const secondStarted = createDeferred();
    const released = createDeferred();
    let continuationSignal: AbortSignal | undefined;
    let continuationRunId: string | undefined;
    runEmbeddedAgent.mockImplementation(async (params) => {
      const { sessionId: id, sessionFile: file, replyOperation: operation } = params;
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
        operation?.attachBackend(backend);
        runs.attachActiveEmbeddedRun(id, backend, sessionKey, file, "main", operation);
        secondStarted.resolve();
        try {
          await released.promise;
        } finally {
          runs.detachActiveEmbeddedRun(id, backend, sessionKey, file);
          operation?.detachBackend(backend);
        }
      }
      return result(id, continuationSignal?.aborted === true);
    });
    await start("Keep working until stopped");
    try {
      await secondStarted.promise;
      const stopped = await rpc("sessions.abort", { key: sessionKey, runId: continuationRunId });
      expect(stopped.mock.calls[0]?.[0]).toBe(true);
      expect(continuationSignal?.aborted).toBe(true);
    } finally {
      if (continuationSignal?.aborted !== true) {
        await setGoalStatus("paused");
      }
      released.resolve();
    }
    await expectDrained();
    expect(runEmbeddedAgent).toHaveBeenCalledTimes(2);
    const stoppedEntry = loadSessionEntry(scope());
    expect(stoppedEntry?.goal?.status).toBe("active");
    expect(stoppedEntry?.abortedLastRun).toBe(true);
    const goal = stoppedEntry?.goal;
    const request = {
      sessionKey,
      sessionId: scope().sessionId,
      goalId: goal?.id,
      action: "resume",
      operationId: "resume-stopped-goal",
      issuedAtMs: Date.now(),
    };
    runEmbeddedAgent.mockImplementation(async (params) => {
      await setGoalStatus("complete");
      return result(params.sessionId);
    });
    const resumed = await rpc("sessions.goal.update", request);
    expect(resumed.mock.calls[0]).toEqual([
      true,
      expect.objectContaining({ status: "started", runId: request.operationId, goalId: goal?.id }),
      undefined,
      expect.anything(),
    ]);
    await expectDrained();
    expect(runEmbeddedAgent).toHaveBeenCalledTimes(3);
    expect(loadSessionEntry(scope())?.goal).toMatchObject({
      id: goal?.id,
      createdAt: goal?.createdAt,
      status: "complete",
    });
    const replay = await rpc("sessions.goal.update", request);
    expect(replay.mock.calls[0]?.[1]).toMatchObject({ replayed: true, runId: request.operationId });
    expect(runEmbeddedAgent).toHaveBeenCalledTimes(3);
    expect(userMessages()).toHaveLength(2);
  });
}
