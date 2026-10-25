import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import type { InternalSessionEntry } from "../../config/sessions.js";
import * as transcriptWatermarks from "../../config/sessions/session-transcript-watermark.js";
import { deriveGatewaySessionLifecycleSnapshot } from "../../gateway/session-lifecycle-state.js";
import { emitAgentEvent, onAgentEvent, type AgentEventPayload } from "../../infra/agent-events.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  createMinimalRunAgentTurnParams,
  getRawExecuteAgentTurnForTest,
  fallbackAttemptOptions,
  initialFallbackAttemptOptions,
  setupAgentRunnerExecutionTestState,
  type EmbeddedAgentParams,
  type FallbackRunnerParams,
} from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();

function createTranscriptStart(generation: string, maxSeq: number) {
  return {
    agentId: "main",
    sessionId: "session",
    sessionKey: "main",
    storePath: "/synthetic/sessions.json",
    generation,
    maxSeq,
  };
}

it("settles the turn's attribution before model-routing hooks run", async () => {
  const executeAgentTurn = await getRawExecuteAgentTurnForTest();
  const capture = createDeferred();
  const entered = createDeferred();
  const hook = vi.fn(async () => undefined);
  const registry = createEmptyPluginRegistry();
  registry.typedHooks.push({
    pluginId: "model-routing-fixture",
    hookName: "before_model_resolve",
    source: "test",
    handler: hook,
  });
  initializeGlobalHookRunner(registry);
  const turn = createMinimalRunAgentTurnParams();
  turn.opts = {
    awaitSessionDiffBaseline: () => {
      entered.resolve();
      return capture.promise;
    },
  };
  state.runEmbeddedAgentMock.mockResolvedValue({ payloads: [{ text: "answer" }], meta: {} });
  const pending = executeAgentTurn(turn);
  try {
    await awaitGateBeforeSettlement(entered.promise, pending, "Model routing skipped attribution");
    expect(hook).not.toHaveBeenCalled();
    capture.resolve();
    await pending;
    expect(hook).toHaveBeenCalledOnce();
  } finally {
    capture.resolve();
    await pending.catch(() => undefined);
    resetGlobalHookRunner();
  }
});

it("announces a remote native run before its worker starts writing replies", async () => {
  const executeAgentTurn = await getRawExecuteAgentTurnForTest();
  const onAgentRunStart = vi.fn();
  const finishObservation = vi.fn(() => {
    throw new Error("synthetic timing sink failure");
  });
  const turn = createMinimalRunAgentTurnParams();
  turn.opts = { onAgentRunStart, onTranscriptStartPreparation: () => finishObservation };
  turn.followupRun.run.config = {
    agents: {
      defaults: { models: { "anthropic/claude": { agentRuntime: { id: "openclaw" } } } },
    },
  };
  const transcriptStart = createTranscriptStart("worker-start", 7);
  const prepare = vi
    .spyOn(transcriptWatermarks, "readSessionTranscriptStartAsync")
    .mockResolvedValue(transcriptStart);
  let startsBeforeReply = -1;
  state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
    await params.onExecutionStarted?.({ backend: "cloud-worker" });
    params.onExecutionPhase?.({ phase: "process_spawned", backend: "cloud-worker" });
    startsBeforeReply = onAgentRunStart.mock.calls.length;
    return { payloads: [{ text: "worker answer" }], meta: {} };
  });
  try {
    const result = await executeAgentTurn(turn);
    expect(result.outcome.kind).toBe("settled");
    expect(startsBeforeReply).toBe(1);
    expect(onAgentRunStart.mock.lastCall?.[3]).toEqual(transcriptStart);
    expect(finishObservation).toHaveBeenCalledOnce();
  } finally {
    prepare.mockRestore();
  }
});

it.each(["settled", "pending"] as const)(
  "uses the starting fallback candidate's facts after a prior %s preparation",
  async (preparationState) => {
    const executeAgentTurn = await getRawExecuteAgentTurnForTest();
    const onAgentRunStart = vi.fn();
    const fallbackModel = "claude-opus-4-6";
    const pendingObservations = new Set<number>();
    let nextObservation = 0;
    const turn = createMinimalRunAgentTurnParams();
    turn.opts = {
      onAgentRunStart,
      onTranscriptStartPreparation: () => {
        const observation = ++nextObservation;
        pendingObservations.add(observation);
        return () => {
          pendingObservations.delete(observation);
        };
      },
    };
    turn.followupRun.run.thinkingCatalog = [
      ...(turn.followupRun.run.thinkingCatalog ?? []),
      { provider: "anthropic", id: fallbackModel, input: ["text"] },
    ];
    const entered = createDeferred();
    const retiredRead =
      createDeferred<
        Awaited<ReturnType<typeof transcriptWatermarks.readSessionTranscriptStartAsync>>
      >();
    const priorStart = createTranscriptStart("transcript-generation", 7);
    const currentStart = { ...priorStart, maxSeq: 11 };
    const prepare = vi
      .spyOn(transcriptWatermarks, "readSessionTranscriptStartAsync")
      .mockImplementationOnce(async () => {
        entered.resolve();
        return preparationState === "pending" ? retiredRead.promise : priorStart;
      })
      .mockResolvedValue(currentStart);
    const preparationFailure = new Error("candidate failed before visible execution");
    let retiredEvent = Promise.resolve();
    let startsBeforeCurrentPhase = -1;
    state.runEmbeddedAgentMock.mockImplementationOnce(
      async (params: RunEmbeddedAgentInternalParams) => {
        if (preparationState === "pending") {
          retiredEvent = Promise.resolve(
            params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } }),
          );
          await entered.promise;
        } else {
          await params.onExecutionStarted?.();
        }
        throw preparationFailure;
      },
    );
    state.runEmbeddedAgentMock.mockImplementationOnce(
      async (params: RunEmbeddedAgentInternalParams) => {
        const currentPreparation = params.onExecutionStarted?.();
        expect([...pendingObservations]).toEqual(preparationState === "pending" ? [1, 2] : [2]);
        retiredRead.resolve(priorStart);
        await retiredEvent;
        await currentPreparation;
        startsBeforeCurrentPhase = onAgentRunStart.mock.calls.length;
        params.onExecutionPhase?.({ phase: "model_call_started" });
        return { payloads: [{ text: "done" }], meta: {} };
      },
    );
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      await expect(
        params.run("anthropic", "claude", initialFallbackAttemptOptions(params)),
      ).rejects.toBe(preparationFailure);
      return {
        result: await params.run(
          "anthropic",
          fallbackModel,
          fallbackAttemptOptions(params, "unknown"),
        ),
        provider: "anthropic",
        model: fallbackModel,
        attempts: [{ provider: "anthropic", model: "claude", error: preparationFailure.message }],
      };
    });
    try {
      const result = await executeAgentTurn(turn);
      expect(result.outcome.kind).toBe("settled");
      expect(startsBeforeCurrentPhase).toBe(0);
      expect(onAgentRunStart).toHaveBeenCalledTimes(1);
      expect(onAgentRunStart.mock.lastCall?.[3]).toEqual(currentStart);
      expect(pendingObservations.size).toBe(0);
    } finally {
      retiredRead.resolve(priorStart);
      await retiredEvent.finally(() => prepare.mockRestore());
    }
  },
);

it("keeps native start facts when an earlier event's preparation settles late", async () => {
  const executeAgentTurn = await getRawExecuteAgentTurnForTest();
  const onAgentRunStart = vi.fn();
  const entered = createDeferred();
  const fallback =
    createDeferred<
      Awaited<ReturnType<typeof transcriptWatermarks.readSessionTranscriptStartAsync>>
    >();
  const nativeStart = createTranscriptStart("native-start", 11);
  const prepare = vi
    .spyOn(transcriptWatermarks, "readSessionTranscriptStartAsync")
    .mockImplementationOnce(() => {
      entered.resolve();
      return fallback.promise;
    });
  state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
    params.onExecutionPhase?.({ phase: "model_call_started" });
    expect(onAgentRunStart).not.toHaveBeenCalled();
    const early = params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });
    await entered.promise;
    await params.onAgentEvent?.({
      stream: "lifecycle",
      data: { phase: "start" },
      transcriptStart: nativeStart,
    });
    fallback.resolve({ ...nativeStart, generation: "earlier-read", maxSeq: 8 });
    await early;
    return { payloads: [{ text: "done" }], meta: {} };
  });
  try {
    await executeAgentTurn(createMinimalRunAgentTurnParams({ opts: { onAgentRunStart } }));
    expect(onAgentRunStart).toHaveBeenCalledTimes(1);
    expect(onAgentRunStart.mock.lastCall?.[3]).toEqual(nativeStart);
    expect(prepare).toHaveBeenCalledTimes(1);
  } finally {
    fallback.resolve(nativeStart);
    prepare.mockRestore();
  }
});

it.each(["embedded preparation", "fallback preparation"])(
  "times %s failure between successful turns without borrowing the previous start",
  async (failureBoundary) => {
    const executeAgentTurn = await getRawExecuteAgentTurnForTest();
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const session: InternalSessionEntry = { sessionId: "session", updatedAt: now };
    const lifecycle: AgentEventPayload[] = [];
    const unsubscribe = onAgentEvent((event) => {
      if (event.stream !== "lifecycle" || event.sessionKey !== "main") {
        return;
      }
      lifecycle.push(event);
      Object.assign(session, deriveGatewaySessionLifecycleSnapshot({ session, event }));
    });
    const onAgentRunStart = vi.fn();
    const transcriptStart = createTranscriptStart("prompt-start-generation", 11);
    const turn = createMinimalRunAgentTurnParams({ opts: { onAgentRunStart } });
    const run = (runId: string) =>
      executeAgentTurn({
        ...turn,
        opts: { ...turn.opts, runId },
        activeSessionStore: { main: session },
        getActiveSessionEntry: () => session,
      });
    const succeed = async (params: EmbeddedAgentParams) => {
      const data = { phase: "start", startedAt: now };
      emitAgentEvent({ runId: params.runId, sessionKey: "main", stream: "lifecycle", data });
      await params.onAgentEvent?.({ stream: "lifecycle", data, transcriptStart });
      expect(onAgentRunStart.mock.lastCall?.[3]).toEqual(transcriptStart);
      expect(session).toMatchObject({ status: undefined, startedAt: now });
      expect(session.lastRunError).toBeUndefined();
      expect(session.runtimeMs).toBeUndefined();
      expect(session.endedAt).toBeUndefined();
      now += 11_192;
      return { payloads: [{ text: "done" }], meta: {} };
    };
    try {
      state.runEmbeddedAgentMock.mockImplementationOnce(succeed);
      await run("timing-previous");
      expect(session).toMatchObject({ status: "done", startedAt: 1_000_000, runtimeMs: 11_192 });

      now = 3_475_979;
      const rejectPreparation = async () => {
        now += 4_700;
        throw new Error("preparation failed before model start");
      };
      if (failureBoundary === "embedded preparation") {
        state.runEmbeddedAgentMock.mockImplementationOnce(rejectPreparation);
      } else {
        state.runEmbeddedAgentEntryMock.mockImplementationOnce(rejectPreparation);
      }
      const failed = await run("timing-failed");
      expect(failed.outcome.kind).toBe("rejected");
      expect(onAgentRunStart).toHaveBeenCalledTimes(1);
      expect(turn.typingSignals.signalRunStart).not.toHaveBeenCalled();
      expect(turn.typingSignals.signalExecutionActivity).not.toHaveBeenCalled();
      const failureEvents = lifecycle.filter((event) => event.runId === "timing-failed");
      expect(failureEvents).toHaveLength(1);
      expect.soft(failureEvents[0]?.data).toMatchObject({
        phase: "error",
        startedAt: 3_475_979,
        endedAt: 3_480_679,
      });
      expect.soft(session).toMatchObject({
        status: "failed",
        startedAt: 3_475_979,
        runtimeMs: 4_700,
        lastRunError: "preparation failed before model start",
      });

      now = 3_600_000;
      state.runEmbeddedAgentMock.mockImplementationOnce(succeed);
      await run("timing-recovered");
      expect(session).toMatchObject({
        status: "done",
        startedAt: 3_600_000,
        endedAt: 3_611_192,
        runtimeMs: 11_192,
      });
      expect(session.lastRunError).toBeUndefined();
      expect(onAgentRunStart).toHaveBeenCalledTimes(2);
      expect(lifecycle.map((event) => [event.runId, event.data.phase])).toEqual([
        ["timing-previous", "start"],
        ["timing-previous", "end"],
        ["timing-failed", "error"],
        ["timing-recovered", "start"],
        ["timing-recovered", "end"],
      ]);
    } finally {
      unsubscribe();
      clock.mockRestore();
    }
  },
);
