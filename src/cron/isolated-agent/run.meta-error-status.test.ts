import { describe, expect, it, vi } from "vitest";
import { FailoverError } from "../../agents/failover-error.js";
import { createAutomationResultRecorder } from "../../infra/agent-run-registry.automation.js";
import { expectObjectFields } from "../../test-utils/mock-call-assertions.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  callGatewayMock,
  appendSessionRuntimeContextMock,
  dispatchCronDeliveryMock,
  loadRunCronIsolatedAgentTurn,
  resolveCronDeliveryPlanMock,
  resolveDeliveryTargetMock,
  resolveCronPayloadOutcomeMock,
  mockRunCronFallbackPassthrough,
  runEmbeddedAgentMock,
  readCronScratchSnapshotMock,
  runWithModelFallbackMock,
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

  it.each([
    { mode: "announce", blocked: false, runs: 0 },
    { mode: "none", blocked: false, runs: 1 },
    { mode: "announce", blocked: true, runs: 1 },
  ] as const)(
    "missing owner route with mode=$mode and DM block=$blocked admits $runs model calls",
    async ({ mode, blocked, runs }) => {
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
      expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(runs);
      if (runs === 0) {
        expect(result).toMatchObject({
          status: "skipped",
          executionStarted: false,
          delivered: false,
          deliveryAttempted: false,
          summary,
        });
        expect(dispatchCronDeliveryMock).not.toHaveBeenCalled();
      } else {
        expect(result.status).toBe("ok");
        expectDispatch({
          deliveryRequested: mode === "announce",
          skipDelivery: blocked ? "channel_transform" : undefined,
        });
      }
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

  it("preserves a provider failure reason independently of its message", async () => {
    const message = "Saved selection requires an update.";
    runWithModelFallbackMock.mockRejectedValueOnce(
      new FailoverError(message, { reason: "model_not_found", provider: "openai" }),
    );
    expect(await runTurn()).toMatchObject({
      status: "error",
      error: message,
      errorClassification: { kind: "reason", reason: "model_not_found" },
    });
  });

  it.each(["pending", "error"] as const)(
    "preserves a run-level error with partial text when delivery disposition is %s",
    async (kind) => {
      mockAgentRun({
        ...failedRun,
        payloads: [{ text: "Partial success-looking text" }],
        meta: { error: { kind: "retry_limit", message: "retry limit exceeded" } },
      });
      dispatchCronDeliveryMock.mockResolvedValueOnce({
        disposition: kind === "error" ? { kind, error: "delivery failed" } : { kind },
        delivered: false,
        deliveryAttempted: true,
        deliveryError: "delivery failed",
        summary: "Pending child summary",
        outputText: "Pending child output",
        deliveryPayloads: [],
      });
      const result = await runTurn();
      const expectedError =
        kind === "error" ? "delivery failed" : "cron isolated run failed: retry limit exceeded";
      expectObjectFields(result, {
        status: "error",
        error: expectedError,
        outputText: kind === "error" ? undefined : expectedError,
        delivered: kind === "pending" ? undefined : false,
        deliveryError: kind === "error" ? "delivery failed" : undefined,
      });
      expect(result.diagnostics?.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: kind === "error" ? "delivery" : "agent-run",
            message: expectedError,
          }),
        ]),
      );
    },
  );

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
    {
      reply: "Report posted. Reply AUTOMATION_FAILED only when the report is blocked.",
      expected: { status: "ok", error: undefined, errorClassification: undefined },
    },
  ])("settles the run from a reported failure line: $expected.status", async (testCase) => {
    await useRealOutcome();
    mockAgentRun({
      payloads: [{ text: testCase.reply }],
      meta: { finalAssistantVisibleText: testCase.reply },
    });
    expectObjectFields(await runTurn(), testCase.expected);
  });

  it("does not mark empty accepted child-session handoffs as cron errors", async () => {
    mockChildRun([], 0);
    mockAnnounceOutcome([], undefined, { deliveryDisposition: { kind: "empty" } });
    const result = await runTurn();
    expectDispatch({
      spawnOnlyHandoff: true,
      skipDelivery: undefined,
      deliveryPayloads: [],
      synthesizedText: undefined,
    });
    expectObjectFields(result, { status: "ok", error: undefined });
  });

  it("preserves a substantive sibling payload instead of treating an accepted child as the only completion", async () => {
    const parentReply = "Checked inbox and calendar.";
    const payloads = [{ text: parentReply }, { text: "NO_REPLY" }];
    mockChildRun(payloads);
    mockAnnounceOutcome(payloads, parentReply, {
      deliveryDisposition: { kind: "silent", controlOnly: false },
    });
    const result = await runTurn();
    expectDispatch({
      spawnOnlyHandoff: false,
      skipDelivery: "silent",
      deliveryPayloads: payloads,
      synthesizedText: parentReply,
      summary: parentReply,
      outputText: parentReply,
    });
    expectObjectFields(result, { summary: parentReply, outputText: parentReply });
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
    expectDispatch({ spawnOnlyHandoff: false, deliveryPayloadHasStructuredContent: true });
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

  it("keeps cron timeout result when executor rejects after the cron abort signal fires", async () => {
    const abortController = new AbortController();
    const timeoutError = new Error(
      "cron: job execution timed out (last phase: model_call_started)",
    );
    timeoutError.name = "TimeoutError";
    abortController.abort(timeoutError);
    await expect(runTurn({ abortSignal: abortController.signal })).rejects.toBe(timeoutError);
    expect(runWithModelFallbackMock).not.toHaveBeenCalled();
  });
});
