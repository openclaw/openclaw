import { describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import type { RunCliAgentParams } from "../../agents/cli-runner/types.js";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import { finalizeCronPromptForResolvedTools } from "../../cron/isolated-agent/run-delivery-trace.js";
import { resolveCronSourceDeliveryPlan } from "../../cron/isolated-agent/source-delivery-plan.js";
import * as cronInference from "../../cron/run-inference.js";
import { TEST_SCHEDULED_OCCURRENCE } from "../../cron/scheduled-occurrence.test-support.js";
import type { CronAgentExecutionPhaseUpdate } from "../../cron/types.js";
import { onAgentEvent, type AgentEventPayload } from "../../infra/agent-events.js";
import {
  consumeCronNextCheckProposal,
  createAutomationResultRecorder,
} from "../../infra/agent-run-registry.automation.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import { useBundledProviderPolicyArtifactsForTest } from "../../plugin-sdk/test-helpers/provider-policy-artifacts.test-support.js";
import {
  createFollowupRun,
  createMinimalRunAgentTurnParams,
  createMockReplyOperation,
  getRawExecuteAgentTurnForTest,
  runInitialFallbackAttempt,
  type FallbackRunnerParams,
  setupAgentRunnerExecutionTestState,
} from "./agent-runner-execution.test-support.js";
import type {
  ScheduledSessionAutomation,
  SessionEventExecution,
} from "./session-event-contract.js";

useBundledProviderPolicyArtifactsForTest(["anthropic"]);
const state = await setupAgentRunnerExecutionTestState();
const executeAgentTurn = await getRawExecuteAgentTurnForTest();

function createScheduledAutomation(): ScheduledSessionAutomation {
  return {
    occurrence: TEST_SCHEDULED_OCCURRENCE,
    admissionSource: "operator-schedule",
    job: {
      id: "scheduled-target-test",
      name: "Scheduled target test",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "session:main",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Check for updates" },
      state: {},
    },
    assertCurrent: vi.fn(),
  };
}

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
  it("captures a structured result before event settlement consumes the invocation", async () => {
    const runId = "automation-result-capture";
    const automation = createScheduledAutomation();
    automation.job.payload = {
      kind: "agentTurn",
      message: "Check quietly",
      includeReasoning: true,
    };
    const followupRun = createFollowupRun();
    const event = createEventExecution();
    followupRun.run.scheduledAutomation = automation;
    followupRun.run.internalEventExecution = event;
    let recordResult: ReturnType<typeof createAutomationResultRecorder> | undefined;
    state.runEmbeddedAgentMock.mockImplementationOnce(async () => {
      recordResult = createAutomationResultRecorder(runId, automation.job.id);
      recordResult({ outcome: "no_change", summary: "Nothing new." });
      return { payloads: [{ text: "No updates." }], meta: {} };
    });
    event.onTerminal = vi.fn(() => {
      expect(() => recordResult?.({ outcome: "done", summary: "Too late." })).toThrow(
        "Automation invocation is no longer active",
      );
      consumeCronNextCheckProposal(runId, automation.job.id);
      expect(getAgentRunContext(runId)?.cronRunsByJobId).toBeUndefined();
    });
    const { replyOperation } = createMockReplyOperation();

    const result = await executeAgentTurn(
      createMinimalRunAgentTurnParams({ followupRun, replyOperation, opts: { runId } }),
    );

    expect(event.onTerminal).toHaveBeenCalledOnce();
    expect(result.outcome).toMatchObject({
      kind: "settled",
      status: "ok",
      automation: {
        result: { outcome: "no_change", summary: "Nothing new." },
        includeReasoning: true,
      },
    });
  });

  it.each(["embedded", "cli"] as const)(
    "retains scheduled destination guidance in the %s turn without changing the system prefix",
    async (runtime) => {
      const followupRun = createFollowupRun();
      const automation = createScheduledAutomation();
      const resolvedDelivery = {
        ok: true as const,
        channel: "telegram",
        to: "scheduled-chat",
        accountId: "scheduled-account",
        threadId: "42",
      };
      const sourceDelivery = resolveCronSourceDeliveryPlan({
        deliveryPlan: { source: "delivery", mode: "announce", requested: true },
        resolvedDelivery,
      });
      automation.finalizePromptForResolvedTools = (params) =>
        finalizeCronPromptForResolvedTools({
          ...params,
          deliveryRequested: true,
          resolvedDelivery,
          sourceDelivery,
        });
      followupRun.run.scheduledAutomation = automation;
      followupRun.run.extraSystemPrompt = "Existing shared session instructions";
      followupRun.run.extraSystemPromptStatic = "Stable shared session instructions";
      const observed: { prompt: string; messageToolAvailable: boolean }[] = [];
      let observedSystemPrompt: string | undefined;
      let observedStaticSystemPrompt: string | undefined;
      const inspectCandidate = async (
        params: RunEmbeddedAgentInternalParams | RunCliAgentParams,
      ) => {
        for (const messageToolAvailable of [true, false]) {
          const prompt =
            params.finalizePromptForResolvedTools?.({
              prompt: params.prompt,
              messageToolAvailable,
            }) ?? params.prompt;
          observed.push({ prompt, messageToolAvailable });
        }
        observedSystemPrompt = params.extraSystemPrompt;
        return { payloads: [{ text: "done" }], meta: {} };
      };
      if (runtime === "cli") {
        useCliFallback(followupRun);
        state.runCliAgentMock.mockImplementationOnce((params: RunCliAgentParams) => {
          observedStaticSystemPrompt = params.extraSystemPromptStatic;
          return inspectCandidate(params);
        });
      } else {
        state.runEmbeddedAgentMock.mockImplementationOnce(inspectCandidate);
      }
      const result = await executeAgentTurn(createMinimalRunAgentTurnParams({ followupRun }));
      expect(result.outcome).toMatchObject({ kind: "settled", status: "ok" });
      expect(observed).toHaveLength(2);
      for (const { prompt, messageToolAvailable } of observed) {
        expect(prompt).toContain("fix it");
        expect(prompt).toContain("delivered automatically");
        if (messageToolAvailable) {
          expect(prompt).toContain('"target":"scheduled-chat"');
        } else {
          expect(prompt).not.toContain("Message delivery destination metadata");
        }
      }
      expect(observedSystemPrompt).toBe("Existing shared session instructions");
      if (runtime === "cli") {
        expect(observedStaticSystemPrompt).toBe("Stable shared session instructions");
      }
    },
  );

  it.for([
    {
      label: "declared fallback",
      fallbacks: ["openai/gpt-5.4"],
      locked: false,
      expected: ["openai/gpt-5.4"],
    },
    { label: "explicit empty fallback", fallbacks: [], locked: false, expected: [] },
    {
      label: "locked session",
      fallbacks: ["openai/gpt-5.4"],
      locked: true,
      expected: [],
    },
  ])(
    "preserves scheduled fallback policy: $label",
    async ({ fallbacks, locked, expected }, { onTestFinished }) => {
      const { resolveModelFallbackOptions } = await import("./agent-runner-run-params.js");
      const utils = await import("./agent-runner-utils.js");
      const resolver = vi.mocked(utils.resolveModelFallbackOptions);
      const previousResolver = resolver.getMockImplementation();
      resolver.mockImplementation(resolveModelFallbackOptions);
      onTestFinished(() => {
        if (previousResolver) {
          resolver.mockImplementation(previousResolver);
        }
      });
      const followupRun = createFollowupRun();
      const automation = createScheduledAutomation();
      automation.job.payload = {
        kind: "agentTurn",
        message: "Check for updates",
        model: "anthropic/claude",
        fallbacks,
      };
      followupRun.run.scheduledAutomation = automation;
      followupRun.run.modelSelectionLocked = locked;
      followupRun.run.config.agents = {
        defaults: { model: { primary: "anthropic/claude", fallbacks: ["openai/gpt-4.1"] } },
      };
      state.runEmbeddedAgentMock.mockResolvedValueOnce({ payloads: [{ text: "done" }], meta: {} });
      const result = await executeAgentTurn(createMinimalRunAgentTurnParams({ followupRun }));
      expect(result.outcome).toMatchObject({ kind: "settled", status: "ok" });
      expect(
        state.runEmbeddedAgentEntryMock.mock.calls[0]?.[0].selection.fallbacksOverride,
      ).toEqual(expected);
    },
  );

  it("keeps the scheduled inference account through native execution and deferred settlement", async ({
    onTestFinished,
  }) => {
    const followupRun = createFollowupRun();
    const automation = createScheduledAutomation();
    automation.job.inferenceBinding = {
      version: 1,
      provider: "anthropic",
      profileId: "scheduled-profile",
      authorizationId: "a".repeat(64),
      authRequirement: "api-key",
      source: "auto",
    };
    followupRun.run.scheduledAutomation = automation;
    followupRun.run.authProfileId = "destination-profile";
    followupRun.run.authProfileIdSource = "user";
    const dispose = vi.fn();
    const assertCandidate = vi.fn();
    const onSuccessfulAuthProfile = vi.fn();
    const authProfileBinding = {
      profileId: "scheduled-profile",
      authRequirement: "api-key" as const,
      assertCurrent: vi.fn(),
      revalidate: vi.fn(async () => {}),
    };
    const acquire = vi.spyOn(cronInference, "prepareCronRunInference").mockResolvedValue({
      runParams: {
        authProfileId: "scheduled-profile",
        authProfileIdSource: "auto",
        authProfileBinding,
        allowAuthProfileFallback: false,
        onSuccessfulAuthProfile,
      },
      assertCandidate,
      resolveCliAuthProfile: vi.fn(async () => "scheduled-profile"),
      dispose,
    });
    onTestFinished(() => acquire.mockRestore());
    const settle = vi.fn(async () => {
      expect(dispose).not.toHaveBeenCalled();
    });
    state.runEmbeddedAgentMock.mockImplementationOnce(
      async (params: RunEmbeddedAgentInternalParams) => {
        expect(params.authProfileId).toBe("scheduled-profile");
        expect(params.authProfileIdSource).toBe("auto");
        expect(params.authProfileBinding).toBe(authProfileBinding);
        expect(params.allowAuthProfileFallback).toBe(false);
        params.onSuccessfulAuthProfile?.("scheduled-profile");
        params.onDeferredLifecycleOwner?.({
          complete: settle,
          discard: vi.fn(),
          beginRetryWait: vi.fn(),
        });
        expect(dispose).not.toHaveBeenCalled();
        return { payloads: [{ text: "done" }], meta: {} };
      },
    );
    const result = await executeAgentTurn(createMinimalRunAgentTurnParams({ followupRun }));
    expect(result.outcome).toMatchObject({ kind: "settled", status: "ok" });
    expect(acquire).toHaveBeenCalledExactlyOnceWith({
      binding: automation.job.inferenceBinding,
      cfg: followupRun.run.config,
      agentDir: followupRun.run.agentDir,
    });
    expect(assertCandidate).toHaveBeenCalledWith("anthropic", false);
    expect(onSuccessfulAuthProfile).toHaveBeenCalledExactlyOnceWith("scheduled-profile");
    expect(settle).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it.for([false, true])(
    "carries scheduled credential authority into CLI preparation (revoked=%s)",
    async (revoke, { onTestFinished }) => {
      const followupRun = createFollowupRun();
      useCliFallback(followupRun);
      const automation = createScheduledAutomation();
      followupRun.run.scheduledAutomation = automation;
      automation.job.inferenceBinding = {
        version: 1,
        provider: "claude-cli",
        profileId: "scheduled-profile",
        authorizationId: "a".repeat(64),
        authRequirement: "subscription",
        source: "auto",
      };
      let retired = false;
      const assertCurrent = vi.fn(() => {
        if (retired) {
          throw new Error("scheduled credential retired");
        }
      });
      const acquire = vi.spyOn(cronInference, "prepareCronRunInference").mockResolvedValue({
        runParams: {
          authProfileId: "scheduled-profile",
          authProfileBinding: {
            profileId: "scheduled-profile",
            authRequirement: "subscription",
            assertCurrent,
            revalidate: async () => {},
          },
        },
        assertCandidate: vi.fn(),
        resolveCliAuthProfile: vi.fn(async () => "scheduled-profile"),
        dispose: vi.fn(),
      });
      onTestFinished(() => acquire.mockRestore());
      state.runCliAgentMock.mockImplementationOnce(async (params: RunCliAgentParams) => {
        expect(params.authProfileId).toBe("scheduled-profile");
        expect(params.assertCurrent).toBeTypeOf("function");
        params.assertCurrent?.();
        retired = revoke;
        // The real CLI owner invokes this guard again after awaited preparation.
        params.assertCurrent?.();
        return { payloads: [{ text: "done" }], meta: {} };
      });
      const result = await executeAgentTurn(createMinimalRunAgentTurnParams({ followupRun }));
      expect(state.runCliAgentMock).toHaveBeenCalledOnce();
      expect(assertCurrent).toHaveBeenCalledTimes(2);
      expect(result.outcome).toMatchObject(
        revoke ? { kind: "rejected" } : { kind: "settled", status: "ok" },
      );
    },
  );

  it.for([
    { runtime: "embedded", outcome: "start" },
    { runtime: "embedded", outcome: "retired" },
    { runtime: "cli", outcome: "start" },
    { runtime: "cli", outcome: "retired" },
  ] as const)(
    "keeps $runtime native execution behind final event admission ($outcome)",
    async ({ runtime, outcome }, { signal }) => {
      const entered = createDeferred();
      const release = createDeferred();
      let current = true;
      const event = createEventExecution();
      const observedProgress: string[] = [];
      event.onStarted = vi.fn(() => {
        observedProgress.push("started");
      });
      const onExecutionPhase = vi.fn((info: CronAgentExecutionPhaseUpdate) => {
        observedProgress.push(info.phase);
      });
      const onLaneWait = vi.fn<NonNullable<ScheduledSessionAutomation["onLaneWait"]>>();
      const nativePhase = runtime === "cli" ? "process_spawned" : "model_call_started";
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
      const providerWork = vi.fn();
      const followupRun = createFollowupRun();
      followupRun.run.internalEventExecution = event;
      followupRun.run.scheduledAutomation = {
        ...createScheduledAutomation(),
        onExecutionPhase,
        onLaneWait,
        executionIdentity: {
          ingress: { kind: "schedule", boundary: "scheduled-event-test", state: "present" },
        },
      };
      if (runtime === "cli") {
        useCliFallback(followupRun);
        state.runCliAgentMock.mockImplementationOnce(async (params: RunCliAgentParams) => {
          await params.onExecutionStarted?.();
          providerWork();
          params.onExecutionPhase?.({
            phase: "process_spawned",
            provider: "claude-cli",
            model: "claude-opus-4-6",
          });
          return { payloads: [{ text: "done" }], meta: {} };
        });
      } else {
        state.runEmbeddedAgentMock.mockImplementationOnce(
          async (params: RunEmbeddedAgentInternalParams) => {
            params.onLaneWait?.({ waiting: true, waitMs: 0, queuedAhead: 1 });
            params.onLaneWait?.({ waiting: false, waitMs: 0, queuedAhead: 0 });
            await params.onExecutionStarted?.();
            providerWork();
            params.onExecutionPhase?.({
              phase: "model_call_started",
              provider: "anthropic",
              model: "claude",
            });
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
        expect(providerWork).not.toHaveBeenCalled();
        expect(onLaneWait.mock.calls.map(([info]) => info?.waiting)).toEqual(
          runtime === "embedded" ? [true, false] : [],
        );
        expect(event.onStarted).not.toHaveBeenCalled();
        expect(onExecutionPhase.mock.calls.some(([info]) => info.phase === nativePhase)).toBe(
          false,
        );
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
        const nativeUpdates = onExecutionPhase.mock.calls
          .map(([info]) => info)
          .filter((info) => info.phase === nativePhase);
        expect(nativeUpdates).toEqual(
          outcome === "start"
            ? [
                {
                  jobId: "scheduled-target-test",
                  agentId: "main",
                  sessionId: "session",
                  sessionKey: "main",
                  runId: result.runId,
                  phase: nativePhase,
                  provider: runtime === "cli" ? "claude-cli" : "anthropic",
                  model: runtime === "cli" ? "claude-opus-4-6" : "claude",
                },
              ]
            : [],
        );
        if (outcome === "start") {
          expect(observedProgress.indexOf("started")).toBeLessThan(
            observedProgress.indexOf(nativePhase),
          );
          expect(result.outcome).toMatchObject({ kind: "settled", status: "ok" });
          expect(providerWork).toHaveBeenCalledOnce();
          expect(event.onStarted).toHaveBeenCalledExactlyOnceWith(result.runId);
          expect(event.onTerminal).toHaveBeenCalledExactlyOnceWith(
            result.runId,
            "completed",
            expectedCompletionEvidence(runtime),
          );
        } else {
          expect(providerWork).not.toHaveBeenCalled();
          expect(event.onStarted).not.toHaveBeenCalled();
          expect(event.onTerminal).toHaveBeenCalledExactlyOnceWith(result.runId, "failed", {
            payloads: [
              {
                isError: true,
                text: "⚠️ OpenClaw couldn't finish this request. Check the conversation before trying again. For details, open Settings → Logs in the Control UI or run `openclaw logs --follow`.",
              },
            ],
            resolved: {
              provider: runtime === "cli" ? "claude-cli" : "anthropic",
              model: runtime === "cli" ? "claude-opus-4-6" : "claude",
            },
          });
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
