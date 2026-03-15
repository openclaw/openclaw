import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearFastTestEnv,
  loadRunCronIsolatedAgentTurn,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronDeliveryPlanMock,
  resolveDeliveryTargetMock,
  restoreFastTestEnv,
  runEmbeddedPiAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function makeParams() {
  return {
    cfg: {},
    deps: {} as never,
    job: {
      id: "announce-target",
      name: "Announce Target",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "daily report" },
      delivery: { mode: "announce", channel: "feishu", to: "ou_xxxxx" },
    } as never,
    message: "daily report",
    sessionKey: "cron:announce-target",
  };
}

describe("runCronIsolatedAgentTurn cron announce target passthrough", () => {
  let previousFastTestEnv: string | undefined;

  const mockFallbackPassthrough = () => {
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
      const result = await run(provider, model);
      return { result, provider, model, attempts: [] };
    });
  };

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("passes messageTo from resolved delivery target to embedded PI agent", async () => {
    mockFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "feishu",
      to: "ou_xxxxx",
    });
    resolveDeliveryTargetMock.mockResolvedValue({
      ok: true,
      channel: "feishu",
      to: "ou_xxxxx",
      accountId: "feishu-account-1",
      threadId: undefined,
    });

    await runCronIsolatedAgentTurn(makeParams());

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const callArgs = runEmbeddedPiAgentMock.mock.calls[0]?.[0];
    expect(callArgs?.messageTo).toBe("ou_xxxxx");
    expect(callArgs?.messageChannel).toBe("feishu");
    expect(callArgs?.agentAccountId).toBe("feishu-account-1");
  });

  it("passes messageThreadId when delivery target includes a threadId", async () => {
    mockFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "feishu",
      to: "ou_xxxxx",
    });
    resolveDeliveryTargetMock.mockResolvedValue({
      ok: true,
      channel: "feishu",
      to: "ou_xxxxx",
      accountId: undefined,
      threadId: "thread_12345",
    });

    await runCronIsolatedAgentTurn(makeParams());

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const callArgs = runEmbeddedPiAgentMock.mock.calls[0]?.[0];
    expect(callArgs?.messageTo).toBe("ou_xxxxx");
    expect(callArgs?.messageThreadId).toBe("thread_12345");
  });

  it("does not pass messageTo when delivery target resolution fails", async () => {
    mockFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "feishu",
      to: "ou_xxxxx",
    });
    resolveDeliveryTargetMock.mockResolvedValue({
      ok: false,
      channel: "feishu",
      to: undefined,
      accountId: undefined,
      error: new Error("Target resolution failed"),
    });

    await runCronIsolatedAgentTurn(makeParams());

    // When delivery target resolution fails, the agent should not receive
    // a messageTo so it does not attempt to send to an invalid target.
    // The run may still proceed (bestEffort) or fail early depending on config.
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const callArgs = runEmbeddedPiAgentMock.mock.calls[0]?.[0];
    expect(callArgs?.messageTo).toBeUndefined();
    expect(callArgs?.messageThreadId).toBeUndefined();
  });

  it("passes messageTo for non-feishu channels (telegram)", async () => {
    mockFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "telegram",
      to: "12345678",
    });
    resolveDeliveryTargetMock.mockResolvedValue({
      ok: true,
      channel: "telegram",
      to: "12345678",
      accountId: undefined,
      threadId: undefined,
    });

    await runCronIsolatedAgentTurn(makeParams());

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const callArgs = runEmbeddedPiAgentMock.mock.calls[0]?.[0];
    expect(callArgs?.messageTo).toBe("12345678");
    expect(callArgs?.messageChannel).toBe("telegram");
  });
});
