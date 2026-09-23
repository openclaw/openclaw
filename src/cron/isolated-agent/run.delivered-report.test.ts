import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearFastTestEnv,
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronDeliveryPlanMock,
  resolveCronPayloadOutcomeMock,
  resolveDeliveryTargetMock,
  restoreFastTestEnv,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const { buildEmbeddedRunPayloads } =
  await import("../../agents/embedded-agent-runner/run/payloads.js");
const { resolveCronPayloadOutcome } =
  await vi.importActual<typeof import("./helpers.js")>("./helpers.js");
let previousFastTestEnv: string | undefined;

beforeEach(() => {
  previousFastTestEnv = clearFastTestEnv();
  resetRunCronIsolatedAgentTurnHarness();
  resolveCronPayloadOutcomeMock.mockImplementation(resolveCronPayloadOutcome);
  mockRunCronFallbackPassthrough();
});

afterEach(() => restoreFastTestEnv(previousFastTestEnv));

it("records a silently completed report as successful after a final read is rate-limited", async () => {
  const delivery = { mode: "none" as const, channel: "topicchat", to: "room#42", threadId: 42 };
  resolveCronDeliveryPlanMock.mockReturnValue({ ...delivery, requested: false });
  resolveDeliveryTargetMock.mockResolvedValue({ ...delivery, ok: true });
  const messagingToolSentTargets = [
    { tool: "message", provider: "topicchat", to: "room#42", threadId: "42", text: "Daily report" },
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
