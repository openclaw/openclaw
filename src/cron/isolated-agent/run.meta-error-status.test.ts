import { describe, expect, it, vi } from "vitest";
import { expectObjectFields } from "../../test-utils/mock-call-assertions.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import * as harness from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await harness.loadRunCronIsolatedAgentTurn();
const runTurn = ({
  job,
  ...overrides
}: { job?: Record<string, unknown>; [key: string]: unknown } = {}) =>
  runCronIsolatedAgentTurn(
    makeIsolatedAgentParamsFixture({ ...overrides, job: makeIsolatedAgentJobFixture(job) }),
  );
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
  harness.runWithModelFallbackMock.mockResolvedValueOnce({
    result: { result: { payloads: [], ...result, meta: { agentMeta: { usage }, ...meta } } },
    provider,
    model,
    attempts: [],
  });
}
function mockChildRun(payloads: unknown[] = []) {
  mockAgentRun({
    payloads,
    usage: { input: 10, output: 1 },
    acceptedSessionSpawns: [{ runId: "run-child", childSessionKey: "agent:default:child" }],
  });
}
const failedDeliveryState = (error: string) => ({
  status: "not-delivered",
  delivered: false,
  error,
  failureNotification: { status: "not-requested" },
});
function mockDelivery(overrides: Record<string, unknown>) {
  harness.dispatchCronDeliveryMock.mockResolvedValueOnce({
    delivered: false,
    deliveryAttempted: true,
    deliveryPayloads: [],
    ...overrides,
  });
}
async function useRealOutcome() {
  const { resolveCronPayloadOutcome } =
    await vi.importActual<typeof import("./helpers.js")>("./helpers.js");
  harness.resolveCronPayloadOutcomeMock.mockImplementation(resolveCronPayloadOutcome);
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
      mockDelivery({
        disposition: { kind: "error", errorKind: "delivery-target", error: deliveryError },
        deliveryAttempted: false,
        deliveryError,
        deliveryState: failedDeliveryState(deliveryError),
        summary: reply,
        outputText: reply,
        deliveryPayloads: [{ text: reply }],
      });
      const result = await runTurn();
      expectObjectFields(result, {
        status: agentFailed ? "error" : "ok",
        error: agentFailed ? "Task blocked" : undefined,
        delivered: false,
        ...(!agentFailed ? { summary: reply, outputText: reply, deliveryError } : {}),
      });
    },
  );

  it("preserves a run-level error with partial text when delivery is pending", async () => {
    mockAgentRun({
      provider: "openai",
      model: "gpt-5.4",
      usage: { input: 0, output: 0 },
      payloads: [{ text: "Partial success-looking text" }],
      meta: { error: { kind: "retry_limit", message: "retry limit exceeded" } },
    });
    mockDelivery({
      disposition: { kind: "pending" },
      deliveryError: "delivery failed",
      summary: "Pending child summary",
      outputText: "Pending child output",
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
    expect(result.diagnostics?.entries).toContainEqual(
      expect.objectContaining({ source: "agent-run", message: expectedError }),
    );
  });

  it.each([false, true])(
    "preserves tool-error status for silent replies (error: %s)",
    async (failed) => {
      await useRealOutcome();
      mockAgentRun({
        payloads: failed ? [{ text: "⚠️ 🛠️ Bash failed: mount unavailable", isError: true }] : [],
        usage: { input: 10, output: failed ? 0 : 1 },
        meta: { terminalReply: { disposition: "silent" } },
      });
      const result = await runTurn();
      expectObjectFields(result, {
        status: failed ? "error" : "ok",
        error: failed ? expect.stringContaining("Bash failed") : undefined,
      });
    },
  );

  it("preserves an empty accepted child handoff failure as a cron error", async () => {
    await useRealOutcome();
    const error = "cron child-session handoff timed out before producing a final assistant payload";
    mockChildRun();
    mockDelivery({
      disposition: { kind: "error", error },
    });
    const result = await runTurn();
    expectObjectFields(result, { status: "error", error, delivered: false });
    expect(harness.dispatchCronDeliveryMock).toHaveBeenCalledWith(
      expect.objectContaining({ spawnOnlyHandoff: true }),
    );
  });

  it("preserves structured-parent delivery failures after accepting a child", async () => {
    const mediaPayload = { mediaUrl: "https://example.invalid/chart.png" };
    const error = "Structured message failed";
    mockChildRun([mediaPayload]);
    await useRealOutcome();
    harness.resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "messagechat",
      to: "test-target",
    });
    mockDelivery({
      deliveryError: error,
      deliveryState: failedDeliveryState(error),
      deliveryPayloads: [mediaPayload],
    });
    const result = await runTurn();
    expect(harness.dispatchCronDeliveryMock).toHaveBeenCalledWith(
      expect.objectContaining({ spawnOnlyHandoff: false }),
    );
    expectObjectFields(result, { status: "ok", deliveryError: error });
  });

  it("records a silently completed report as successful after a final read is rate-limited", async () => {
    const { buildEmbeddedRunPayloads } =
      await import("../../agents/embedded-agent-runner/run/payloads.js");
    await useRealOutcome();
    harness.mockRunCronFallbackPassthrough();
    const delivery = { mode: "none" as const, channel: "topicchat", to: "room#42", threadId: 42 };
    harness.resolveCronDeliveryPlanMock.mockReturnValue({ ...delivery, requested: false });
    harness.resolveDeliveryTargetMock.mockResolvedValue({ ...delivery, ok: true });
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
    harness.runEmbeddedAgentMock.mockResolvedValue({
      payloads,
      didSendViaMessagingTool: true,
      messagingToolSentTargets,
      meta: {
        agentMeta: { usage: { input: 10, output: 20 } },
        terminalReply: { disposition: "silent" },
      },
    });

    const result = await runTurn({
      job: {
        id: "delivered-report",
        delivery,
      },
      sessionKey: "cron:delivered-report",
    });

    expectObjectFields(result, {
      status: "ok",
      error: undefined,
      delivered: true,
      replyDisposition: "silent",
    });
  });
});
