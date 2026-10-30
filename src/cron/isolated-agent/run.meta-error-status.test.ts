import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, vi } from "vitest";
import { getCurrentSessionControllerOwner } from "../../sessions/session-controller.lifecycle.js";
import { expectObjectFields } from "../../test-utils/mock-call-assertions.js";
import { cronFailureDetailLines } from "../failure-notification-text.js";
import { resolveCronRunErrorReason } from "../run-error-reason.js";
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

  it.each(["return", "throw"] as const)(
    "retains the controller watchdog cause when the agent settles via %s",
    async (settlement) => {
      const cancel = vi.fn();
      harness.runWithModelFallbackMock.mockImplementationOnce(async () => {
        const operation = expectDefined(getCurrentSessionControllerOwner(), "cron controller");
        operation.setPhase("running");
        operation.attachBackend({ kind: "embedded", cancel });
        const execution = operation.watchdog.beginExecution(() => Date.now() - 1);
        try {
          await operation.watchdog.tick();
          expect(operation.abortSignal.aborted).toBe(true);
          expect(cancel).toHaveBeenCalledOnce();
          if (settlement === "throw") {
            throw new Error("PRIVATE cleanup detail: session placement turn settlement is closed");
          }
          return {
            result: {
              result: {
                payloads: [],
                meta: {
                  aborted: true,
                  error: {
                    kind: "incomplete_turn",
                    message: "PRIVATE cleanup detail: session placement turn settlement is closed",
                  },
                },
              },
            },
            provider: "openai",
            model: "gpt-5.4",
            attempts: [],
          };
        } finally {
          execution.close();
        }
      });
      const result = await runTurn();
      expectObjectFields(result, {
        status: "error",
        error: "Session watchdog stopped the run after its execution deadline.",
        errorClassification: { kind: "permanent" },
        failureNotificationDetail: { kind: "agent-watchdog", reason: "execution_deadline" },
      });
      expect(result.diagnostics?.entries).toContainEqual(
        expect.objectContaining({
          source: "agent-run",
          message: "Session watchdog stopped the run after its execution deadline.",
        }),
      );
      expect(
        cronFailureDetailLines(
          resolveCronRunErrorReason(result.error, result.provider, result.errorClassification),
          result.failureNotificationDetail,
        ),
      ).toEqual([
        "Cause: Session watchdog stopped the run after its execution deadline.",
        "Open automation history and inspect the stalled step before retrying.",
      ]);
      expect(result.diagnostics?.summary).toBe(
        "Session watchdog stopped the run after its execution deadline.",
      );
      expect(result.diagnostics?.entries).toContainEqual(
        expect.objectContaining({
          source: "agent-run",
          message: "PRIVATE cleanup detail: session placement turn settlement is closed",
        }),
      );
      expect(harness.runWithModelFallbackMock).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps a rate-limit stop outside watchdog failure notifications", async () => {
    harness.runWithModelFallbackMock.mockImplementationOnce(async () => {
      const operation = expectDefined(getCurrentSessionControllerOwner(), "cron controller");
      operation.setPhase("running");
      const wait = operation.watchdog.beginWait({
        kind: "retry",
        deadlineAtMs: Date.now() + 60_000,
        rateLimitStopMessage: "Synthetic provider rate limit exhausted",
        isCurrent: () => true,
      });
      try {
        operation.abortForStall("semantic_stall");
        expect(operation.abortSignal.reason).toMatchObject({
          message: "Synthetic provider rate limit exhausted",
          code: "OPENCLAW_SESSION_WATCHDOG",
        });
      } finally {
        wait.close();
      }
      return {
        result: { result: { payloads: [], meta: { aborted: true } } },
        provider: "openai",
        model: "gpt-5.4",
        attempts: [],
      };
    });
    const result = await runTurn();
    expect(result.failureNotificationDetail).toBeUndefined();
  });

  it.each([
    "user",
    "restart",
    "unclassified-watchdog",
    "upstream-cancel",
    "provider-error",
  ] as const)("does not disclose a watchdog classification for %s cancellation", async (cause) => {
    const upstream = new AbortController();
    harness.runWithModelFallbackMock.mockImplementationOnce(async () => {
      const operation = expectDefined(getCurrentSessionControllerOwner(), "cron controller");
      operation.setPhase("running");
      if (cause === "user") {
        operation.abortByUser();
      } else if (cause === "restart") {
        operation.abortForRestart();
      } else if (cause === "unclassified-watchdog") {
        operation.abortForStall("PRIVATE arbitrary cancellation reason");
      } else if (cause === "upstream-cancel") {
        const execution = operation.watchdog.beginExecution(() => Date.now() - 1);
        try {
          await operation.watchdog.tick();
          upstream.abort();
        } finally {
          execution.close();
        }
      }
      return {
        result: {
          result: {
            payloads: [],
            meta:
              cause === "provider-error"
                ? {
                    error: {
                      kind: "incomplete_turn",
                      message: "OPENCLAW_SESSION_WATCHDOG semantic_stall PRIVATE provider body",
                    },
                  }
                : { aborted: true },
          },
        },
        provider: "openai",
        model: "gpt-5.4",
        attempts: [],
      };
    });
    const result = await runTurn({ abortSignal: upstream.signal });
    expect(result.failureNotificationDetail).toBeUndefined();
    expect(cronFailureDetailLines(undefined, result.failureNotificationDetail)).toEqual([
      "Check automation history for details.",
    ]);
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
