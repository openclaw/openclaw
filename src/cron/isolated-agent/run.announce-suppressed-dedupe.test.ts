/**
 * Regression test for #42244: announce delivery skipping when message tool
 * sends were suppressed.
 *
 * When `delivery.mode: "announce"` + `deliveryContract: "shared"`, the
 * message tool is disabled (by design -- announce mode handles delivery).
 * If the agent run still reports `didSendViaMessagingTool: true` with
 * matching targets (stale/residual), the dedupe guard must NOT treat
 * those suppressed sends as completed delivery. The announce path should
 * proceed normally.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import {
  clearFastTestEnv,
  loadRunCronIsolatedAgentTurn,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronDeliveryPlanMock,
  resolveDeliveryTargetMock,
  restoreFastTestEnv,
  runWithModelFallbackMock,
  runEmbeddedPiAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function makeParams() {
  return {
    cfg: {},
    deps: {} as never,
    job: {
      id: "announce-dedupe",
      name: "Announce Dedupe",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "run announce task" },
      delivery: { mode: "announce", channel: "telegram", to: "123456" },
    } as never,
    message: "run announce task",
    sessionKey: "cron:announce-dedupe",
  };
}

function mockFallbackPassthrough() {
  runWithModelFallbackMock.mockImplementation(
    async ({
      provider,
      model,
      run,
    }: {
      provider: string;
      model: string;
      run: (p: string, m: string) => Promise<unknown>;
    }) => {
      const result = await run(provider, model);
      return { result, provider, model, attempts: [] };
    },
  );
}

describe("runCronIsolatedAgentTurn -- announce suppressed send dedupe (#42244)", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();

    resolveDeliveryTargetMock.mockResolvedValue({
      ok: true,
      channel: "telegram",
      to: "123456",
      accountId: undefined,
      threadId: undefined,
      mode: "explicit",
    });

    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "telegram",
      to: "123456",
      source: "delivery",
    });

    // The harness mock returns undefined which causes TypeError in delivery
    // dispatch. Override to return a proper result array.
    vi.mocked(deliverOutboundPayloads).mockResolvedValue([{ ok: true } as never]);
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("does not treat stale didSendViaMessagingTool as delivery when message tool is disabled (shared)", async () => {
    mockFallbackPassthrough();

    // The embedded agent reports a messaging tool send to the delivery target.
    // This is stale/residual since the tool was disabled for this run.
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "task completed, sent summary" }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      didSendViaMessagingTool: true,
      messagingToolSentTargets: [{ provider: "telegram", to: "123456" }],
    });

    const res = await runCronIsolatedAgentTurn({
      ...makeParams(),
      deliveryContract: "shared",
    });

    // With the fix, skipMessagingToolDelivery is false (message tool was
    // disabled, so the stale flag is ignored). The announce delivery path
    // should fire. deliveryAttempted must be true.
    expect(res.status).toBe("ok");
    expect(res.deliveryAttempted).toBe(true);
    // delivered may be true or false depending on whether the mocked
    // outbound actually returns results; the key assertion is that
    // deliveryAttempted is true (announce was not skipped).
  });

  it("cron-owned contract ignores stale didSendViaMessagingTool and attempts delivery", async () => {
    mockFallbackPassthrough();

    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "cron output" }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      didSendViaMessagingTool: true,
      messagingToolSentTargets: [{ provider: "telegram", to: "123456" }],
    });

    // Default deliveryContract is "cron-owned"
    const res = await runCronIsolatedAgentTurn(makeParams());

    expect(res.status).toBe("ok");
    // cron-owned never sets skipMessagingToolDelivery (first condition is
    // deliveryContract === "shared"), so announce delivery should fire.
    expect(res.deliveryAttempted).toBe(true);
  });

  it("does not interfere with delivery when didSendViaMessagingTool is false", async () => {
    mockFallbackPassthrough();

    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "clean output" }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      didSendViaMessagingTool: false,
      messagingToolSentTargets: [],
    });

    const res = await runCronIsolatedAgentTurn({
      ...makeParams(),
      deliveryContract: "shared",
    });

    expect(res.status).toBe("ok");
    // Normal announce delivery should proceed.
    expect(res.deliveryAttempted).toBe(true);
  });
});
