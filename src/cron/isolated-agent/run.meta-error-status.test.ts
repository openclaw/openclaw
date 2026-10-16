import { describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { expectObjectFields } from "../../test-utils/mock-call-assertions.js";
import { dispatchCronDelivery } from "./delivery-dispatch.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  dispatchCronDeliveryMock,
  listDescendantRunsForRequesterMock,
  loadRunCronIsolatedAgentTurn,
  resolveCronDeliveryPlanMock,
  resolveCronPayloadOutcomeMock,
  runWithModelFallbackMock,
  mockRunCronFallbackPassthrough,
  resolveDeliveryTargetMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

// mock-isolation: Keep the database-backed descendant registry outside the fixed child-run fixture.
vi.mock("./delivery-subagent-registry.runtime.js", () => ({
  hasUnsettledCronDescendants: async () => false,
}));

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
      const reply = agentFailed ? "Task blocked" : "REPORT_COMPLETE";
      mockAgentRun({
        payloads: [{ text: reply, ...(agentFailed ? { isError: true } : {}) }],
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

  it("preserves a heartbeat-only accepted child handoff failure as a cron error", async () => {
    const heartbeatPayload = { text: "HEARTBEAT_OK" };
    const error = "cron child-session handoff timed out before producing a final assistant payload";
    mockChildRun([heartbeatPayload]);
    mockAnnounceOutcome([heartbeatPayload], heartbeatPayload.text, {
      deliveryDisposition: { kind: "heartbeat", controlOnly: true },
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
    expect(result.summary).not.toBe(heartbeatPayload.text);
    expect(result.outputText).not.toBe(heartbeatPayload.text);
  });

  it("records the child result after a no-delivery parent returns only a heartbeat", async () => {
    await useRealOutcome();
    const reply = "Finished the delegated report";
    mockChildRun([{ text: "HEARTBEAT_OK" }]);
    resolveCronDeliveryPlanMock.mockReturnValue({ mode: "none", requested: false });
    listDescendantRunsForRequesterMock.mockResolvedValue([
      {
        runId: "run-child",
        childSessionKey: "agent:default:child",
        requesterSessionKey: "agent:default:cron:test",
        requesterDisplayKey: "agent:default:cron:test",
        createdAt: Date.now(),
        task: "delegated report",
        cleanup: "keep",
        execution: { status: "terminal", endedAt: Date.now() + 1_000, outcome: { status: "ok" } },
        completion: { required: true, terminalReply: { disposition: "visible", text: reply } },
      },
    ]);
    dispatchCronDeliveryMock.mockImplementation(dispatchCronDelivery);

    const result = await runTurn({
      job: makeIsolatedAgentJobFixture({ delivery: { mode: "none" } }),
    });

    expectObjectFields(result, { status: "ok", outputText: reply });
    expect(result.deliveryState?.status).toBe("not-requested");
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

    const cfg = {};
    setRuntimeConfigSnapshot(cfg);
    const result = await runCronIsolatedAgentTurn({
      deliveryAttemptFence: null,
      cfg,
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
