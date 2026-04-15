import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearFastTestEnv,
  dispatchCronDeliveryMock,
  isHeartbeatOnlyResponseMock,
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronDeliveryPlanMock,
  resolveDeliveryTargetMock,
  restoreFastTestEnv,
  runEmbeddedPiAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function makeParams() {
  return {
    cfg: {},
    deps: {} as never,
    job: {
      id: "message-tool-policy",
      name: "Message Tool Policy",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "send a message" },
      delivery: { mode: "none" },
    } as never,
    message: "send a message",
    sessionKey: "cron:message-tool-policy",
  };
}

describe("runCronIsolatedAgentTurn message tool policy", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();
    resolveDeliveryTargetMock.mockResolvedValue({
      ok: true,
      channel: "telegram",
      to: "123",
      accountId: undefined,
      error: undefined,
    });
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("keeps the message tool enabled for cron-owned runs regardless of delivery mode", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: false,
      mode: "none",
    });
    await runCronIsolatedAgentTurn(makeParams());
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.disableMessageTool).toBe(false);
  });

  it("keeps the message tool enabled for cron-owned runs when delivery is active", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "telegram",
      to: "123",
    });
    await runCronIsolatedAgentTurn(makeParams());
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.disableMessageTool).toBe(false);
  });

  it("disables the message tool for shared callers when delivery is requested", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "telegram",
      to: "123",
    });

    await runCronIsolatedAgentTurn({
      ...makeParams(),
      deliveryContract: "shared",
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.disableMessageTool).toBe(true);
  });

  it("keeps the message tool enabled for shared callers when delivery is not requested", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: false,
      mode: "none",
    });

    await runCronIsolatedAgentTurn({
      ...makeParams(),
      deliveryContract: "shared",
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.disableMessageTool).toBe(false);
  });

  it("skips cron delivery when output is heartbeat-only", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "telegram",
      to: "123",
    });
    isHeartbeatOnlyResponseMock.mockReturnValue(true);

    await runCronIsolatedAgentTurn({
      ...makeParams(),
      job: {
        id: "message-tool-policy",
        name: "Message Tool Policy",
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "send a message" },
        delivery: { mode: "announce", channel: "telegram", to: "123" },
      } as never,
    });

    expect(dispatchCronDeliveryMock).toHaveBeenCalledTimes(1);
    expect(dispatchCronDeliveryMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        deliveryRequested: true,
        skipHeartbeatDelivery: true,
      }),
    );
  });

  it("does not skip cron delivery when the message tool send is not the final handoff", async () => {
    mockRunCronFallbackPassthrough();
    const params = makeParams();
    const job = {
      id: "message-tool-policy",
      name: "Message Tool Policy",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "send a message" },
      delivery: { mode: "announce", channel: "telegram", to: "123" },
    } as const;
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "telegram",
      to: "123",
    });
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "sent" }],
      didSendViaMessagingTool: true,
      messagingToolSentTargets: [{ tool: "message", provider: "telegram", to: "123" }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
    });

    await runCronIsolatedAgentTurn({
      ...params,
      deliveryContract: "shared",
      job: job as never,
    });

    expect(dispatchCronDeliveryMock).toHaveBeenCalledTimes(1);
    expect(dispatchCronDeliveryMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        deliveryRequested: true,
        skipMessagingToolDelivery: false,
      }),
    );
  });

  it("skips cron delivery only when the message tool handled the final reply", async () => {
    mockRunCronFallbackPassthrough();
    const params = makeParams();
    const job = {
      id: "message-tool-policy",
      name: "Message Tool Policy",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "send a message" },
      delivery: { mode: "announce", channel: "telegram", to: "123" },
    } as const;
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "telegram",
      to: "123",
    });
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "NO_REPLY" }],
      didSendViaMessagingTool: true,
      messagingToolSentTargets: [{ tool: "message", provider: "telegram", to: "123" }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
    });

    await runCronIsolatedAgentTurn({
      ...params,
      deliveryContract: "shared",
      job: job as never,
    });

    expect(dispatchCronDeliveryMock).toHaveBeenCalledTimes(1);
    expect(dispatchCronDeliveryMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        deliveryRequested: true,
        skipMessagingToolDelivery: true,
      }),
    );
  });
});

describe("runCronIsolatedAgentTurn delivery instruction", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();
    resolveDeliveryTargetMock.mockResolvedValue({
      ok: true,
      channel: "telegram",
      to: "123",
      accountId: undefined,
      error: undefined,
    });
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("appends an explicit delivery target instruction when delivery is requested", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "telegram",
      to: "123",
    });

    await runCronIsolatedAgentTurn(makeParams());

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const prompt: string = runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.prompt ?? "";
    expect(prompt).toContain("When using the message tool for this cron delivery");
    expect(prompt).toContain('channel to "telegram"');
    expect(prompt).toContain('target to "123"');
    expect(prompt).toContain("NO_REPLY");
  });

  it("serializes delivery target values and includes threadId in the instruction", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "telegram",
      to: "123",
      threadId: "topic-42",
      accountId: "acc-7",
    });
    resolveDeliveryTargetMock.mockResolvedValue({
      ok: true,
      channel: 'tele"gram',
      to: '12\n3',
      threadId: 'topic"42',
      accountId: "acc\n7",
      error: undefined,
    });

    await runCronIsolatedAgentTurn(makeParams());

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const prompt: string = runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.prompt ?? "";
    expect(prompt).toContain(`channel to ${JSON.stringify('tele"gram')}`);
    expect(prompt).toContain(`target to ${JSON.stringify('12\n3')}`);
    expect(prompt).toContain(`with threadId ${JSON.stringify('topic"42')}`);
    expect(prompt).toContain(`with accountId ${JSON.stringify("acc\n7")}`);
  });

  it("does not append a delivery instruction when delivery is not requested", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({ requested: false, mode: "none" });

    await runCronIsolatedAgentTurn(makeParams());

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const prompt: string = runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.prompt ?? "";
    expect(prompt).not.toContain("When using the message tool for this cron delivery");
    expect(prompt).not.toContain("NO_REPLY");
  });

  it("does not instruct the agent to summarize when delivery is requested", async () => {
    // Regression for https://github.com/openclaw/openclaw/issues/58535:
    // "summary" caused LLMs to condense structured output and drop fields
    // non-deterministically on every run.
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "telegram",
      to: "123",
    });

    await runCronIsolatedAgentTurn(makeParams());

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const prompt: string = runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.prompt ?? "";
    expect(prompt).not.toMatch(/\bsummary\b/i);
  });
});
