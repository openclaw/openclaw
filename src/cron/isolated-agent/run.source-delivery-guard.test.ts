import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  clearAgentRunContext,
  getAgentRunContext,
  registerAgentRunContext,
} from "../../infra/agent-run-registry.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import * as harness from "./run.test-harness.js";

const { resolveCronDeliveryPlan } =
  await vi.importActual<typeof import("../delivery-plan.js")>("../delivery-plan.js");
const runCronIsolatedAgentTurn = await harness.loadRunCronIsolatedAgentTurn();
const runTurn = (job: Record<string, unknown>, cfg: OpenClawConfig = {}) =>
  runCronIsolatedAgentTurn(
    makeIsolatedAgentParamsFixture({ cfg, job: makeIsolatedAgentJobFixture(job) }),
  );

describe("cron source delivery policy", () => {
  setupRunCronIsolatedAgentTurnSuite();
  beforeEach(() => {
    harness.mockRunCronFallbackPassthrough();
    harness.resolveCronDeliveryPlanMock.mockImplementation(resolveCronDeliveryPlan);
  });

  it.each([
    { mode: "none", disabled: false, explicitTarget: false, channel: "messagechat" },
    { mode: "announce", disabled: false, explicitTarget: true, channel: "messagechat" },
    { mode: "webhook", disabled: true, explicitTarget: false, channel: undefined },
  ] as const)("runs delivery mode $mode with its prepared tool policy", async (row) => {
    harness.resolveDeliveryTargetMock.mockResolvedValue({
      ok: true,
      channel: "messagechat",
      to: "123",
      accountId: "acct-1",
      threadId: "thread-99",
    });
    harness.registerAgentRunContextMock.mockImplementation(
      (...args: Parameters<typeof registerAgentRunContext>) => {
        const [runId] = args;
        onTestFinished(() => clearAgentRunContext(runId));
        expect(getAgentRunContext(runId)).toBeDefined();
        registerAgentRunContext(...args);
      },
    );
    onTestFinished(() => {
      harness.registerAgentRunContextMock.mockReset();
    });
    const embeddedRun = expectDefined(
      harness.runEmbeddedAgentMock.getMockImplementation(),
      "embedded result",
    );
    harness.runEmbeddedAgentMock.mockImplementationOnce((params) => {
      expect(getAgentRunContext(params.runId)?.sessionEventDelivery).toBe(
        row.mode === "none" || row.mode === "webhook" ? false : undefined,
      );
      return embeddedRun(params);
    });
    const result = await runTurn({
      delivery: { mode: row.mode, channel: "messagechat", to: "123" },
    });
    expect(result.status, result.error).toBe("ok");
    expect(harness.runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(harness.runEmbeddedAgentMock.mock.calls[0]?.[0]).toMatchObject({
      disableMessageTool: row.disabled,
      forceMessageTool: false,
      requireExplicitMessageTarget: row.explicitTarget,
      messageToolFinalByDefault: false,
      messageChannel: row.channel,
      ...(row.channel
        ? { messageTo: "123", agentAccountId: "acct-1", messageThreadId: "thread-99" }
        : {}),
    });
  });

  it("executes a DM-blocked automation and records intentional nondelivery without sending", async () => {
    const { dispatchCronDelivery } =
      await vi.importActual<typeof import("./delivery-dispatch.js")>("./delivery-dispatch.js");
    harness.dispatchCronDeliveryMock.mockImplementationOnce(dispatchCronDelivery);
    harness.resolveDeliveryTargetMock.mockResolvedValue({
      ok: false,
      channel: "none",
      mode: "explicit",
      error: new Error("Owner delivery unavailable (dm-blocked)"),
      deliverySuppressionReason: "channel_transform",
    });
    const result = await runTurn({
      delivery: { mode: "announce", target: "owner", directPolicy: "block" },
    });
    expect(harness.runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(harness.runEmbeddedAgentMock.mock.calls[0]?.[0].disableMessageTool).toBe(true);
    expect(result).toMatchObject({
      status: "ok",
      delivered: false,
      deliverySuppressionReason: "channel_transform",
    });
    expect(result.deliveryError).toBeUndefined();
  });

  it("honors an explicit OpenClaw runtime override during cron execution", async () => {
    harness.resolveConfiguredModelRefMock.mockReturnValue({
      provider: "openai",
      model: "gpt-5.6-luna",
    });
    harness.resolveCronSessionMock.mockReturnValue(
      harness.makeCronSession({
        sessionEntry: harness.makeCronSessionEntry({
          agentRuntimeOverride: "openclaw",
          agentHarnessId: "codex",
        }),
      }),
    );
    const result = await runTurn(
      { payload: { kind: "agentTurn", message: "run an Ultra task", thinking: "ultra" } },
      {
        agents: {
          defaults: { models: { "openai/gpt-5.6-luna": { agentRuntime: { id: "codex" } } } },
        },
      },
    );
    expect(result.status).toBe("ok");
    expect(harness.runEmbeddedAgentMock.mock.calls[0]?.[0]).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-luna",
      thinkLevel: "ultra",
      agentHarnessRuntimeOverride: "openclaw",
    });
    expect(harness.runEmbeddedAgentMock.mock.calls[0]?.[0]).not.toHaveProperty("agentHarnessId");
  });
});
