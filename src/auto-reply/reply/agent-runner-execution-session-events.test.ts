import { describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import type { RunCliAgentParams } from "../../agents/cli-runner/types.js";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import { onAgentEvent, type AgentEventPayload } from "../../infra/agent-events.js";
import { useBundledProviderPolicyArtifactsForTest } from "../../plugin-sdk/test-helpers/provider-policy-artifacts.test-support.js";
import {
  createFollowupRun,
  createMinimalRunAgentTurnParams,
  createScheduledAutomation,
  runInitialFallbackAttempt,
  type FallbackRunnerParams,
  setupAgentRunnerExecutionTestState,
} from "./agent-runner-execution.test-support.js";
import type { SessionEventExecution } from "./session-event-contract.js";

useBundledProviderPolicyArtifactsForTest(["anthropic"]);
const state = await setupAgentRunnerExecutionTestState();
const { executeAgentTurn } = await import("./agent-runner-execution.js");

function createEventExecution(): SessionEventExecution {
  return { onStarted: vi.fn(), onTerminal: vi.fn() };
}

function useCliFallback(followupRun: ReturnType<typeof createFollowupRun>) {
  followupRun.run.provider = "claude-cli";
  followupRun.run.model = "claude-opus-4-6";
  state.isCliProviderMock.mockReturnValue(true);
  state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
    result: await runInitialFallbackAttempt(params, "claude-cli", "claude-opus-4-6"),
    provider: "claude-cli",
    model: "claude-opus-4-6",
    attempts: [],
  }));
}

function expectedCompletionEvidence(runtime: "embedded" | "cli") {
  const provider = runtime === "cli" ? "claude-cli" : "anthropic";
  const model = runtime === "cli" ? "claude-opus-4-6" : "claude";
  return expect.objectContaining({
    payloads: [{ text: "done" }],
    meta: expect.objectContaining({
      executionTrace: {
        attempts: [{ provider, model, result: "success" }],
        fallbackUsed: false,
        winnerModel: model,
        winnerProvider: provider,
      },
    }),
  });
}

describe("ordinary session event execution", () => {
  it.for([
    { runtime: "embedded", outcome: "start" },
    { runtime: "embedded", outcome: "retired" },
    { runtime: "cli", outcome: "start" },
    { runtime: "cli", outcome: "retired" },
  ] as const)(
    "keeps $runtime native binding behind final event admission ($outcome)",
    async ({ runtime, outcome }, { signal }) => {
      const entered = createDeferred();
      const release = createDeferred();
      let current = true;
      const event = createEventExecution();
      event.assertCurrent = () => {
        if (!current) {
          throw new Error("event source retired at final admission");
        }
      };
      event.beforeStart = vi.fn(async () => {});
      const scheduledRuns: string[] = [];
      event.beforeScheduledStart = async (runId) => {
        scheduledRuns.push(runId);
        entered.resolve();
        await release.promise;
      };
      const bind = vi.fn();
      const providerWork = vi.fn();
      const followupRun = createFollowupRun();
      followupRun.run.internalEventExecution = event;
      followupRun.run.scheduledAutomation = {
        ...createScheduledAutomation(),
        executionIdentity: {
          ingress: { kind: "schedule", boundary: "scheduled-event-test", state: "present" },
          onExecutionStarted: bind,
        },
      };
      if (runtime === "cli") {
        useCliFallback(followupRun);
        state.runCliAgentMock.mockImplementationOnce(async (params: RunCliAgentParams) => {
          await params.onExecutionStarted?.();
          providerWork();
          params.onExecutionPhase?.({ phase: "process_spawned" });
          return { payloads: [{ text: "done" }], meta: {} };
        });
      } else {
        state.runEmbeddedAgentMock.mockImplementationOnce(
          async (params: RunEmbeddedAgentInternalParams) => {
            await params.onExecutionStarted?.();
            providerWork();
            params.onExecutionPhase?.({ phase: "model_call_started" });
            return { payloads: [{ text: "done" }], meta: {} };
          },
        );
      }
      const runId = `scheduled-${runtime}-${outcome}`;
      const lifecycleEvents: AgentEventPayload[] = [];
      const unsubscribe = onAgentEvent((lifecycleEvent) => {
        if (lifecycleEvent.runId === runId && lifecycleEvent.stream === "lifecycle") {
          lifecycleEvents.push(lifecycleEvent);
        }
      });
      const pending = executeAgentTurn(
        createMinimalRunAgentTurnParams({ followupRun, opts: { runId } }),
      );
      try {
        await withinTest(
          awaitGateBeforeSettlement(entered.promise, pending, "final event admission"),
          signal,
        );
        expect(event.beforeStart).toHaveBeenCalledOnce();
        expect(scheduledRuns).toEqual([expect.any(String)]);
        expect(bind).not.toHaveBeenCalled();
        expect(providerWork).not.toHaveBeenCalled();
        expect(event.onStarted).not.toHaveBeenCalled();
        expect(
          lifecycleEvents.some((lifecycleEvent) => lifecycleEvent.data.phase === "start"),
        ).toBe(false);
        current = outcome === "start";
        release.resolve();
        const result = await pending;
        expect(result.runId).toBe(scheduledRuns[0]);
        expect(event.beforeStart).toHaveBeenCalledOnce();
        expect(scheduledRuns).toEqual([result.runId]);
        expect(
          runtime === "cli" ? state.runCliAgentMock : state.runEmbeddedAgentMock,
        ).toHaveBeenCalledOnce();
        if (outcome === "start") {
          expect(result.outcome).toMatchObject({ kind: "settled", status: "ok" });
          expect(bind).toHaveBeenCalledOnce();
          expect(providerWork).toHaveBeenCalledOnce();
          expect(event.onStarted).toHaveBeenCalledExactlyOnceWith(result.runId);
          expect(event.onTerminal).toHaveBeenCalledExactlyOnceWith(
            result.runId,
            "completed",
            expectedCompletionEvidence(runtime),
          );
        } else {
          expect(bind).not.toHaveBeenCalled();
          expect(providerWork).not.toHaveBeenCalled();
          expect(event.onStarted).not.toHaveBeenCalled();
          expect(event.onTerminal).toHaveBeenCalledExactlyOnceWith(
            result.runId,
            "failed",
            undefined,
          );
          expect(
            lifecycleEvents.some((lifecycleEvent) => lifecycleEvent.data.phase === "start"),
          ).toBe(false);
          expect(
            lifecycleEvents.find((lifecycleEvent) => lifecycleEvent.data.phase === "error")?.data,
          ).toMatchObject({
            executionStarted: false,
            providerStarted: false,
          });
        }
      } finally {
        release.resolve();
        await Promise.allSettled([pending]);
        unsubscribe();
      }
    },
  );

  it("waits for source preparation and rejects revoked authority before runtime I/O", async ({
    signal,
  }) => {
    const entered = createDeferred();
    const release = createDeferred();
    let current = true;
    const event = createEventExecution();
    event.assertCurrent = () => {
      if (!current) {
        throw new Error("event source retired");
      }
    };
    event.beforeStart = async () => {
      entered.resolve();
      await release.promise;
    };
    const followupRun = createFollowupRun();
    followupRun.run.internalEventExecution = event;
    const pending = executeAgentTurn(createMinimalRunAgentTurnParams({ followupRun }));
    const rejected = expect(pending).rejects.toThrow("event source retired");
    try {
      await withinTest(entered.promise, signal);
      current = false;
      expect(state.resolveCurrentTurnImagesMock).not.toHaveBeenCalled();
      expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
      expect(event.onTerminal).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
    await rejected;
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(event.onStarted).not.toHaveBeenCalled();
    expect(event.onTerminal).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      "failed",
      undefined,
    );
  });

  it.for(["embedded", "cli"] as const)(
    "records ordinary event start and terminal once through %s",
    async (runtime) => {
      const event = createEventExecution();
      event.beforeStart = vi.fn(async () => {});
      event.beforeScheduledStart = vi.fn(async () => {});
      const followupRun = createFollowupRun();
      followupRun.run.internalEventExecution = event;
      const run = async (params: RunEmbeddedAgentInternalParams | RunCliAgentParams) => {
        if (runtime === "embedded") {
          expect(params.trigger).toBe("event");
        } else {
          expect(params.onExecutionStarted).toBeUndefined();
        }
        await params.onExecutionStarted?.();
        params.onExecutionPhase?.({ phase: "model_call_started" });
        params.onExecutionPhase?.({ phase: "assistant_output_started" });
        return { payloads: [{ text: "done" }], meta: {} };
      };
      if (runtime === "cli") {
        useCliFallback(followupRun);
        state.runCliAgentMock.mockImplementationOnce(run);
      } else {
        state.runEmbeddedAgentMock.mockImplementationOnce(run);
      }
      const result = await executeAgentTurn(createMinimalRunAgentTurnParams({ followupRun }));
      expect(result.outcome).toMatchObject({ kind: "settled", status: "ok" });
      expect(event.beforeStart).toHaveBeenCalledOnce();
      expect(event.beforeScheduledStart).not.toHaveBeenCalled();
      expect(event.onStarted).toHaveBeenCalledExactlyOnceWith(result.runId);
      expect(event.onTerminal).toHaveBeenCalledExactlyOnceWith(
        result.runId,
        "completed",
        expectedCompletionEvidence(runtime),
      );
    },
  );

  it("does not record a second terminal when the source terminal callback fails", async () => {
    const event = createEventExecution();
    const terminal = vi.fn(async () => {
      throw new Error("event settlement retired");
    });
    event.onTerminal = terminal;
    const followupRun = createFollowupRun();
    followupRun.run.internalEventExecution = event;
    state.runEmbeddedAgentMock.mockResolvedValueOnce({ payloads: [{ text: "done" }], meta: {} });
    await expect(
      executeAgentTurn(createMinimalRunAgentTurnParams({ followupRun })),
    ).rejects.toThrow("event settlement retired");
    expect(terminal).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      "completed",
      expectedCompletionEvidence("embedded"),
    );
  });
});
