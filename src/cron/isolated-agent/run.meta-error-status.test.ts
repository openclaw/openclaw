import { describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import {
  createReplyOperation,
  type ReplyOperation,
} from "../../auto-reply/reply/reply-run-registry.js";
import { deriveGatewaySessionLifecycleProjectionPatch } from "../../gateway/session-lifecycle-state.js";
import { onAgentEventForRun, type AgentEventPayload } from "../../infra/agent-events.js";
import { createAutomationResultRecorder } from "../../infra/agent-run-registry.automation.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import { onGatewayWorkMetricsChanged } from "../../infra/gateway-work-metrics-events.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { expectObjectFields } from "../../test-utils/mock-call-assertions.js";
import {
  clearCronJobActive,
  isCronActiveJobMarkerCurrent,
  markCronJobActive,
} from "../active-jobs.js";
import { isCronExecutionIdle } from "../execution-idle.js";
import { waitForCronExecutionIdle } from "../service/execution-idle.js";
import { runWithCronAdmission } from "../service/run-admission-capacity.js";
import { createCronServiceState } from "../service/state.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import type { RunCronAgentTurnParams } from "./run-prepare-runtime.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  callGatewayMock,
  appendSessionRuntimeContextMock,
  dispatchCronDeliveryMock,
  loadRunCronIsolatedAgentTurn,
  resolveCronDeliveryPlanMock,
  resolveCronPayloadOutcomeMock,
  readCronScratchSnapshotMock,
  runWithModelFallbackMock,
  mockRunCronFallbackPassthrough,
  resolveDeliveryTargetMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const runTurn = (overrides = {}) =>
  runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture(overrides));
const failedRun = { provider: "openai", model: "gpt-5.4", usage: { input: 0, output: 0 } };
function mockAgentRun({
  provider = "anthropic",
  model = "claude-opus-4-8",
  usage = { input: 10, output: 0 },
  meta = {},
  ...result
}: {
  provider?: string;
  model?: string;
  usage?: { input: number; output: number };
  meta?: Record<string, unknown>;
  [key: string]: unknown;
} = {}) {
  runWithModelFallbackMock.mockResolvedValueOnce({
    result: { result: { payloads: [], ...result, meta: { agentMeta: { usage }, ...meta } } },
    provider,
    model,
    attempts: [],
  });
}
function mockChildRun(payloads: unknown[] = [], output = 1) {
  mockAgentRun({
    payloads,
    usage: { input: 10, output },
    acceptedSessionSpawns: [{ runId: "run-child", childSessionKey: "agent:default:child" }],
  });
}
function mockAnnounceOutcome(
  payloads: unknown[] = [],
  text?: string,
  overrides: Record<string, unknown> = {},
) {
  resolveCronDeliveryPlanMock.mockReturnValue({
    requested: true,
    mode: "announce",
    channel: "messagechat",
    to: "test-target",
  });
  resolveCronPayloadOutcomeMock.mockReturnValue({
    summary: text,
    outputText: text,
    synthesizedText: text,
    deliveryPayload: payloads.at(-1),
    deliveryPayloads: payloads,
    deliveryDisposition: { kind: "visible" },
    deliveryPayloadHasStructuredContent: false,
    hasFatalErrorPayload: false,
    hasFatalStructuredErrorPayload: false,
    embeddedRunError: undefined,
    ...overrides,
  });
}
function expectDispatch(expected: Record<string, unknown>) {
  expect(dispatchCronDeliveryMock).toHaveBeenCalledWith(expect.objectContaining(expected));
}
async function useRealOutcome() {
  const { resolveCronPayloadOutcome } =
    await vi.importActual<typeof import("./helpers.js")>("./helpers.js");
  resolveCronPayloadOutcomeMock.mockImplementation(resolveCronPayloadOutcome);
}

describe("runCronIsolatedAgentTurn - meta.error status propagation", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it.each([false, true])(
    "keeps delivery target failure separate from execution (agent failed: %s)",
    async (agentFailed) => {
      await useRealOutcome();
      const reply = agentFailed ? "AUTOMATION_FAILED\nTask blocked" : "REPORT_COMPLETE";
      mockAgentRun({
        payloads: [{ text: reply }],
        meta: { finalAssistantVisibleText: reply },
      });
      const deliveryError = "Channel is required (no configured channels detected).";
      dispatchCronDeliveryMock.mockResolvedValueOnce({
        disposition: { kind: "error", errorKind: "delivery-target", error: deliveryError },
        delivered: false,
        deliveryAttempted: false,
        deliveryError,
        deliveryState: {
          status: "not-delivered",
          delivered: false,
          error: deliveryError,
          failureNotification: { status: "not-requested" },
        },
        summary: reply,
        outputText: reply,
        deliveryPayloads: [{ text: reply }],
      });
      const result = await runTurn();
      expectObjectFields(result, {
        status: agentFailed ? "error" : "ok",
        error: agentFailed ? "Task blocked" : undefined,
        delivered: false,
      });
      if (!agentFailed) {
        expectObjectFields(result, {
          summary: "REPORT_COMPLETE",
          outputText: "REPORT_COMPLETE",
          deliveryError,
        });
      }
    },
  );

  it.each([
    { mode: "announce", blocked: false },
    { mode: "none", blocked: false },
    { mode: "announce", blocked: true },
  ] as const)(
    "executes with missing owner route, mode=$mode and DM block=$blocked",
    async ({ mode, blocked }) => {
      mockRunCronFallbackPassthrough();
      const summary =
        "Owner delivery unavailable (no-route); configure an authorized owner DM or edit this automation's delivery";
      resolveCronDeliveryPlanMock.mockReturnValue({
        mode,
        target: "owner",
        requested: mode === "announce",
      });
      resolveDeliveryTargetMock.mockResolvedValue({
        ok: false,
        mode: "explicit",
        channel: "none",
        error: new Error(summary),
        ...(blocked ? { deliverySuppressionReason: "channel_transform" } : {}),
      });
      const result = await runTurn({
        job: makeIsolatedAgentJobFixture({ delivery: { mode, target: "owner" } }),
      });
      expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
      expect(result.status).toBe("ok");
      expectDispatch({
        deliveryRequested: mode === "announce",
        skipDelivery: blocked ? "channel_transform" : undefined,
        resolvedDelivery: expect.objectContaining({ ok: false, error: expect.any(Error) }),
      });
    },
  );

  it("defers a prepared run when its active window closes before inference", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-02T09:00:00Z"));
    try {
      mockRunCronFallbackPassthrough();
      runEmbeddedAgentMock.mockImplementationOnce(async (request) => {
        clock.mockReturnValue(Date.parse("2026-10-02T11:00:00Z"));
        await request.onExecutionStarted?.();
        throw new Error("a deferred run must not continue");
      });
      const result = await runTurn({
        job: makeIsolatedAgentJobFixture({
          activeHours: { start: "09:00", end: "10:00", timezone: "UTC" },
        }),
      });
      expect(result).toMatchObject({
        status: "skipped",
        executionStarted: false,
        admissionDeferred: true,
      });
      expect(dispatchCronDeliveryMock).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it.for(["resume", "abort", "revoke", "started-error"] as const)(
    "retains one isolated invocation through late foreground admission: %s",
    async (completion, { signal }) => {
      mockRunCronFallbackPassthrough();
      const cfg = { agents: { entries: { main: {} } } };
      const job = makeIsolatedAgentJobFixture({
        agentId: "main",
        schedule: { kind: "on-exit", command: "observed-command" },
        idleOnly: true,
        delivery: { mode: "none" },
      });
      const scheduler = createTestGatewayScheduler();
      const state = createCronServiceState({
        scheduler,
        storePath: "/tmp/isolated-idle-unused/jobs.json",
        cronEnabled: true,
        log: { debug() {}, info() {}, warn() {}, error() {} },
        enqueueSystemEvent() {
          throw new Error("An isolated turn must not enqueue a replacement event");
        },
        async runIsolatedAgentJob() {
          throw new Error("The admitted isolated invocation must not be restarted");
        },
        isExecutionIdle: (candidate, ownSessionKey) =>
          isCronExecutionIdle(cfg, candidate, "main", ownSessionKey),
      });
      const marker = markCronJobActive("test-job", { agentId: "main" });
      const controller = new AbortController();
      const abortSignal = AbortSignal.any([controller.signal, signal]);
      const assertCurrent = () => {
        if (!isCronActiveJobMarkerCurrent(marker)) {
          throw new Error("Synthetic cron occurrence retired");
        }
      };
      const idleWait = createDeferred();
      const attempts: string[] = [];
      const inference: string[] = [];
      const terminals: AgentEventPayload[] = [];
      let unsubscribeLifecycle = () => {};
      const started = vi.fn<NonNullable<RunCronAgentTurnParams["onExecutionStarted"]>>();
      let foreground: ReplyOperation | undefined;
      let invocationContext: ReturnType<typeof getAgentRunContext>;
      const unsubscribe = onGatewayWorkMetricsChanged(() => {
        if (foreground && marker?.idleAdmissionWait && state.runAdmission.active === 0) {
          idleWait.resolve();
        }
      });
      runEmbeddedAgentMock.mockImplementationOnce(async (request) => {
        attempts.push(request.runId);
        unsubscribeLifecycle = onAgentEventForRun(request.runId, (event) => {
          if (
            event.stream === "lifecycle" &&
            (event.data.phase === "end" || event.data.phase === "error")
          ) {
            terminals.push(event);
          }
        });
        invocationContext = getAgentRunContext(request.runId);
        foreground = createReplyOperation({
          sessionKey: "agent:main:chat:isolated-late-foreground",
          sessionId: "isolated-late-foreground",
          resetTriggered: false,
          turnKind: "visible",
        });
        await request.onExecutionStarted?.();
        expect(state.runAdmission.active).toBe(1);
        expect(isCronActiveJobMarkerCurrent(marker)).toBe(true);
        expect(marker?.idleAdmissionWait).toBeUndefined();
        expect(getAgentRunContext(request.runId)).toBe(invocationContext);
        inference.push(request.runId);
        if (completion === "started-error") {
          throw new Error("Started isolated execution failed");
        }
        return { payloads: [{ text: "Observed exit handled" }], meta: { agentMeta: {} } };
      });
      const waitForIdle: NonNullable<RunCronAgentTurnParams["waitForIdle"]> = (
        ownSessionKey,
        waiterSignal,
      ) =>
        waitForCronExecutionIdle(state, job, {
          activeJobMarker: marker,
          ownSessionKey,
          signal: waiterSignal ?? abortSignal,
          assertCurrent,
        });
      const pending = runWithCronAdmission(
        state,
        () =>
          runTurn({
            cfg,
            agentId: "main",
            job,
            abortSignal,
            assertCurrent,
            waitForIdle,
            onExecutionStarted: started,
          }),
        undefined,
        abortSignal,
      );
      try {
        await withinTest(
          awaitGateBeforeSettlement(idleWait.promise, pending, "late idle admission was bypassed"),
          signal,
        );
        expect(attempts).toHaveLength(1);
        expect(invocationContext).toBeDefined();
        expect(getAgentRunContext(attempts[0]!)).toBe(invocationContext);
        expect(isCronActiveJobMarkerCurrent(marker)).toBe(true);
        expect(state.runAdmission.active).toBe(0);
        expect(inference).toEqual([]);
        expect(started).not.toHaveBeenCalled();
        expect(dispatchCronDeliveryMock).not.toHaveBeenCalled();
        expect(foreground?.abortSignal.aborted).toBe(false);

        if (completion === "abort") {
          controller.abort(new Error("Stop isolated idle run"));
        } else {
          if (completion === "revoke") {
            clearCronJobActive("test-job", marker);
          }
          foreground?.complete();
        }
        const outcome = await withinTest(pending, signal);
        expect(outcome.kind).toBe("admitted");
        if (outcome.kind !== "admitted") {
          throw new Error("The original isolated admission was lost");
        }
        expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
        expect(attempts).toHaveLength(1);
        expect(getAgentRunContext(attempts[0]!)).toBeUndefined();
        expect(state.runAdmission.active).toBe(0);
        expect(terminals).toHaveLength(1);
        const terminal = terminals[0]!;
        const projection = deriveGatewaySessionLifecycleProjectionPatch({
          entry: {
            updatedAt: 2,
            startedAt: 1,
            endedAt: 2,
            lastRunId: "prior-completed-run",
            lastRunError: "prior timeout",
          },
          event: terminal,
        });
        if (completion === "resume" || completion === "started-error") {
          expect(terminal.data.executionStarted).not.toBe(false);
          expect(terminal.data.providerStarted).not.toBe(false);
          expect(projection).toMatchObject({
            status: completion === "resume" ? "done" : "failed",
            lastRunId: attempts[0],
          });
        } else {
          expect(terminal.data).toMatchObject({ executionStarted: false, providerStarted: false });
          expect(projection).toEqual({});
        }
        if (completion === "resume") {
          expect(outcome.value.status).toBe("ok");
          expect(inference).toEqual(attempts);
          expect(started).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ runId: attempts[0] }),
          );
          expect(dispatchCronDeliveryMock).toHaveBeenCalledOnce();
        } else if (completion === "started-error") {
          expect(outcome.value).toMatchObject({
            status: "error",
            executionStarted: true,
            error: "Started isolated execution failed",
          });
          expect(inference).toEqual(attempts);
          expect(started).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ runId: attempts[0] }),
          );
          expect(dispatchCronDeliveryMock).not.toHaveBeenCalled();
        } else {
          expect(outcome.value).toMatchObject({
            status: "error",
            executionStarted: false,
            error:
              completion === "abort"
                ? "Stop isolated idle run"
                : "Synthetic cron occurrence retired",
          });
          expect(inference).toEqual([]);
          expect(started).not.toHaveBeenCalled();
          expect(dispatchCronDeliveryMock).not.toHaveBeenCalled();
          expect(foreground?.abortSignal.aborted).toBe(false);
        }
      } finally {
        controller.abort(new Error("Isolated idle proof cleanup"));
        foreground?.complete();
        unsubscribe();
        await Promise.allSettled([pending]);
        unsubscribeLifecycle();
        clearCronJobActive("test-job", marker);
        await scheduler.stop();
      }
    },
  );

  it("supplies bounded job scratch and warns before replacing a partial view", async () => {
    mockRunCronFallbackPassthrough();
    readCronScratchSnapshotMock.mockResolvedValueOnce({
      jobId: "test-job",
      state: {
        currentRevision: 3,
        scratch: { content: "x".repeat(2200), revision: 3, updatedAtMs: 1 },
      },
    });
    await runTurn();
    const prompt = runEmbeddedAgentMock.mock.calls[0]?.[0]?.prompt;
    expect(prompt).toContain("Automation scratch (revision 3)");
    expect(prompt).toContain("x".repeat(2000));
    expect(prompt).not.toContain("x".repeat(2001));
    expect(prompt).toContain("reread the complete scratch before replacing it");
  });

  it.each(["no_change", "needs_attention"] as const)(
    "settles the structured %s outcome through ordinary delivery",
    async (outcome) => {
      mockRunCronFallbackPassthrough();
      await useRealOutcome();
      resolveCronDeliveryPlanMock.mockReturnValue({
        requested: true,
        mode: "announce",
        channel: "messagechat",
        to: "test-target",
      });
      runEmbeddedAgentMock.mockImplementationOnce(async ({ runId }) => {
        createAutomationResultRecorder(
          runId,
          "test-job",
        )({ outcome, summary: "Inspection complete" });
        return {
          payloads: [{ text: "Inspection complete" }],
          meta: { agentMeta: { usage: { input: 1, output: 1 } } },
        };
      });
      const result = await runTurn();
      expect(result).toMatchObject({ status: "ok", summary: `${outcome}: Inspection complete` });
      expectDispatch({ skipDelivery: outcome === "no_change" ? "silent" : undefined });
      expect(appendSessionRuntimeContextMock).toHaveBeenCalledTimes(
        outcome === "no_change" ? 0 : 1,
      );
    },
  );

  it.each(["test-session-id", "retired-creator"])(
    "records an isolated result only in its captured creating conversation (%s)",
    async (sourceSessionId) => {
      mockRunCronFallbackPassthrough();
      runEmbeddedAgentMock.mockImplementationOnce(async ({ runId }) => {
        createAutomationResultRecorder(
          runId,
          "test-job",
        )({
          outcome: "needs_attention",
          summary: "Inspection complete",
        });
        return { payloads: [{ text: "Inspection complete" }], meta: { agentMeta: {} } };
      });
      const result = await runTurn({
        job: makeIsolatedAgentJobFixture({
          sourceConversation: { sessionKey: "agent:main:creator", sessionId: sourceSessionId },
          delivery: { mode: "announce", channel: "messagechat", to: "external-recipient" },
        }),
      });
      expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
      if (sourceSessionId === "retired-creator") {
        expect(result).toMatchObject({
          status: "error",
          error: "Automation result creating conversation was replaced before settlement",
        });
        expect(appendSessionRuntimeContextMock).not.toHaveBeenCalled();
      } else {
        expect(result.status).toBe("ok");
        expect(appendSessionRuntimeContextMock).toHaveBeenCalledWith(
          expect.objectContaining({
            scope: expect.objectContaining({
              sessionKey: "agent:main:creator",
              sessionId: sourceSessionId,
            }),
          }),
        );
      }
    },
  );

  it.each([false, true])(
    "includes reasoning only when explicitly requested (%s)",
    async (includeReasoning) => {
      mockRunCronFallbackPassthrough();
      await useRealOutcome();
      const reasoning = { text: "Inspection reasoning", isReasoning: true };
      const answer = { text: "Inspection complete" };
      runEmbeddedAgentMock.mockResolvedValueOnce({
        payloads: [reasoning, answer],
        meta: { agentMeta: { usage: { input: 1, output: 1 } } },
      });
      await runTurn({
        job: makeIsolatedAgentJobFixture({
          payload: { kind: "agentTurn", message: "inspect", includeReasoning },
        }),
      });
      expectDispatch({ deliveryPayloads: includeReasoning ? [reasoning, answer] : [answer] });
    },
  );

  it("preserves a run-level error with partial text when delivery is pending", async () => {
    mockAgentRun({
      ...failedRun,
      payloads: [{ text: "Partial success-looking text" }],
      meta: { error: { kind: "retry_limit", message: "retry limit exceeded" } },
    });
    dispatchCronDeliveryMock.mockResolvedValueOnce({
      disposition: { kind: "pending" },
      delivered: false,
      deliveryAttempted: true,
      deliveryError: "delivery failed",
      summary: "Pending child summary",
      outputText: "Pending child output",
      deliveryPayloads: [],
    });
    const result = await runTurn();
    const expectedError = "cron isolated run failed: retry limit exceeded";
    expectObjectFields(result, {
      status: "error",
      error: expectedError,
      outputText: expectedError,
      delivered: undefined,
      deliveryError: undefined,
    });
    expect(result.diagnostics?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "agent-run",
          message: expectedError,
        }),
      ]),
    );
  });

  it("marks an aborted embedded agent run without a run-level error as a cron error", async () => {
    mockAgentRun({ ...failedRun, meta: { aborted: true } });
    const result = await runTurn({
      job: makeIsolatedAgentJobFixture({ deleteAfterRun: true }),
    });
    expectObjectFields(result, { status: "error", error: "cron isolated agent run aborted" });
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("keeps explicit silent replies as successful cron completions", async () => {
    await useRealOutcome();
    mockAgentRun({
      usage: { input: 10, output: 1 },
      meta: { finalAssistantRawText: "NO_REPLY", finalAssistantVisibleText: "NO_REPLY" },
    });
    const result = await runTurn();
    expect(dispatchCronDeliveryMock).toHaveBeenCalled();
    expectObjectFields(result, { status: "ok", error: undefined });
  });

  it("records a real tool error when the terminal assistant reply is silent", async () => {
    await useRealOutcome();
    mockAgentRun({
      payloads: [{ text: "⚠️ 🛠️ Bash failed: mount unavailable", isError: true }],
      meta: { finalAssistantVisibleText: "NO_REPLY" },
    });
    const result = await runTurn();
    expect(result.status).toBe("error");
    expect(result.error).toContain("Bash failed");
  });

  it.each([
    {
      // Transient-looking prose must not turn the agent's verdict into a scheduler retry.
      reply: "AUTOMATION_FAILED\nNetwork timeout: no shell tool is available in this run.",
      expected: {
        status: "error",
        error: "Network timeout: no shell tool is available in this run.",
        errorClassification: { kind: "permanent", reportedByAgent: true },
      },
    },
  ])("settles the run from a reported failure line: $expected.status", async (testCase) => {
    await useRealOutcome();
    mockAgentRun({
      payloads: [{ text: testCase.reply }],
      meta: { finalAssistantVisibleText: testCase.reply },
    });
    expectObjectFields(await runTurn(), testCase.expected);
  });

  it("preserves a silent accepted child handoff failure as a cron error", async () => {
    const silentPayload = { text: "NO_REPLY" };
    const error = "cron child-session handoff timed out before producing a final assistant payload";
    mockChildRun([silentPayload]);
    mockAnnounceOutcome([silentPayload], silentPayload.text, {
      deliveryDisposition: { kind: "silent", controlOnly: true },
    });
    dispatchCronDeliveryMock.mockImplementationOnce(() => ({
      disposition: { kind: "error", error },
      delivered: false,
      deliveryAttempted: true,
      summary: undefined,
      outputText: undefined,
      synthesizedText: undefined,
      deliveryPayloads: [],
    }));
    const result = await runTurn();
    expectObjectFields(result, { status: "error", error, delivered: false });
    expect(result.summary).not.toBe(silentPayload.text);
    expect(result.outputText).not.toBe(silentPayload.text);
  });

  it("preserves structured-parent delivery failures after accepting a child", async () => {
    const mediaPayload = { mediaUrl: "https://example.invalid/chart.png" };
    const error = "Structured message failed";
    mockChildRun([mediaPayload]);
    mockAnnounceOutcome([mediaPayload], undefined, { deliveryPayloadHasStructuredContent: true });
    dispatchCronDeliveryMock.mockResolvedValueOnce({
      delivered: false,
      deliveryAttempted: true,
      deliveryError: error,
      deliveryState: {
        status: "not-delivered",
        delivered: false,
        error,
        failureNotification: { status: "not-requested" },
      },
      deliveryPayloads: [mediaPayload],
    });
    const result = await runTurn();
    expectDispatch({ spawnOnlyHandoff: false });
    expectObjectFields(result, { status: "ok", deliveryError: error });
  });

  it("surfaces cron timeout result when the cron-nested lane watchdog fires", async () => {
    const error = new Error('Command lane "cron-nested" task timed out after 330000ms');
    error.name = "CommandLaneTaskTimeoutError";
    runWithModelFallbackMock.mockRejectedValueOnce(error);
    const result = await runTurn();
    expectObjectFields(result, {
      status: "error",
      error: "cron: job execution timed out",
      provider: "openai",
      model: "gpt-5.4",
      sessionId: "test-session-id",
    });
    expect(result.error).not.toContain("CommandLaneTaskTimeoutError");
    expect(result.error).not.toContain("cron-nested");
  });
});

const { buildEmbeddedRunPayloads } =
  await import("../../agents/embedded-agent-runner/run/payloads.js");

describe("delivered report outcome", () => {
  setupRunCronIsolatedAgentTurnSuite();
  it("records a silently completed report as successful after a final read is rate-limited", async () => {
    await useRealOutcome();
    mockRunCronFallbackPassthrough();
    const delivery = { mode: "none" as const, channel: "topicchat", to: "room#42", threadId: 42 };
    resolveCronDeliveryPlanMock.mockReturnValue({ ...delivery, requested: false });
    resolveDeliveryTargetMock.mockResolvedValue({ ...delivery, ok: true });
    const messagingToolSentTargets = [
      {
        tool: "message",
        provider: "topicchat",
        to: "room#42",
        threadId: "42",
        text: "Daily report",
      },
    ];
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: ["NO_REPLY"],
      lastAssistant: undefined,
      isCronTrigger: true,
      sessionKey: "cron:delivered-report",
      verboseLevel: "off",
      didSendViaMessagingTool: true,
      messagingToolSentTargets,
      lastToolError: {
        toolName: "codex_apps.slack.slack_read_thread",
        error: "429 RATE_LIMITED",
        mutatingAction: false,
      },
    });
    runEmbeddedAgentMock.mockResolvedValue({
      payloads,
      didSendViaMessagingTool: true,
      messagingToolSentTargets,
      meta: {
        agentMeta: { usage: { input: 10, output: 20 } },
        finalAssistantVisibleText: "NO_REPLY",
        finalAssistantRawText: "NO_REPLY",
      },
    });

    const result = await runCronIsolatedAgentTurn({
      deliveryAttemptFence: null,
      cfg: {},
      deps: {} as never,
      job: {
        id: "delivered-report",
        name: "Daily report",
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "Run the daily report" },
        delivery,
      } as never,
      message: "Run the daily report",
      sessionKey: "cron:delivered-report",
    });

    expect(runEmbeddedAgentMock, JSON.stringify(result)).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("ok");
    expect(result.error).toBeUndefined();
    expect(result.delivered).toBe(true);
    expect(result.replyDisposition).toBe("silent");
  });
});
