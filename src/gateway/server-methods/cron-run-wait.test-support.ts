import { expect, it, vi, type Mock } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as cronDeliveryTarget from "../../cron/isolated-agent/delivery-target.js";
import { getGatewayProcessInstanceId } from "../process-instance.js";
import {
  createCronCallerClient as callerClient,
  createCronJob,
  createCronTestContext,
  createCronTestInvoker,
} from "./cron.validation.test-support.js";
import type { GatewayRequestHandlers } from "./types.js";

export function registerCronRunWaitTests({
  handlers,
  getRuntimeConfig,
}: {
  handlers: GatewayRequestHandlers;
  getRuntimeConfig: Mock<() => OpenClawConfig>;
}) {
  const invokeCron = createCronTestInvoker(handlers, getRuntimeConfig);
  it.each([
    { name: "main", job: { sessionTarget: "main" }, waits: false },
    {
      name: "aliased own session",
      job: { sessionTarget: "session:agent:ops:main" },
      mainKey: "work",
      waits: false,
    },
    {
      name: "current-session announce into the caller",
      job: {
        sessionTarget: "current",
        sessionKey: "agent:ops:main",
        delivery: { mode: "announce" },
      },
      waits: false,
    },
    {
      name: "isolated result commit into the caller",
      job: {
        sessionTarget: "isolated",
        sourceConversation: { sessionKey: "agent:ops:main", sessionId: "creator" },
        delivery: { mode: "announce" },
      },
      waits: false,
    },
    {
      name: "script result commit into the caller",
      job: {
        sessionTarget: "isolated",
        sourceConversation: { sessionKey: "agent:ops:main", sessionId: "creator" },
        payload: { kind: "script", script: "return { notify: 'report' };" },
        delivery: { mode: "announce" },
      },
      waits: false,
    },
    {
      // Quiet current jobs run detached and never commit into the conversation.
      name: "quiet current-session",
      job: { sessionTarget: "current", sessionKey: "agent:ops:main", delivery: { mode: "none" } },
      waits: true,
    },
    {
      // The automations tool stamps the creator's session onto non-isolated jobs.
      name: "other named session created from the caller",
      job: { sessionTarget: "session:reports", sessionKey: "agent:ops:main" },
      waits: true,
    },
  ] as const)(
    "waits for a $name run from an agent turn only when it can finish meanwhile",
    async ({ job, mainKey, waits }) => {
      getRuntimeConfig.mockReturnValue(mainKey ? { session: { mainKey } } : {});
      const context = createCronTestContext(
        createCronJob({ id: "cron-1", agentId: "ops", ...job }),
        getRuntimeConfig,
      );

      const { respond } = await invokeCron(
        "cron.run",
        { id: "cron-1", waitTimeoutMs: 60_000 },
        {
          context,
          client: callerClient("ops", undefined, mainKey ? `agent:ops:${mainKey}` : undefined),
        },
      );

      // The caller's turn holds the main lane and its own session lane, so those runs
      // only start after this request returns; waiting would just burn the budget.
      expect(context.cron.waitForManualRun).toHaveBeenCalledTimes(waits ? 1 : 0);
      expect(respond).toHaveBeenCalledWith(
        true,
        {
          ok: true,
          enqueued: true,
          runId: "run-1",
          processInstanceId: getGatewayProcessInstanceId(),
        },
        undefined,
      );
    },
  );

  it.each([
    { creatorIsCaller: false, destinationIsCaller: true, waits: false },
    { creatorIsCaller: true, destinationIsCaller: false, waits: true },
  ])(
    "waits on the destination lane, not the creator lane ($destinationIsCaller)",
    async ({ creatorIsCaller, destinationIsCaller, waits }) => {
      const callerSessionKey = "agent:ops:telegram:direct:123";
      const destinationSessionKey = destinationIsCaller
        ? callerSessionKey
        : "agent:ops:telegram:direct:456";
      const resolveTarget = vi
        .spyOn(cronDeliveryTarget, "resolveDeliveryTarget")
        .mockResolvedValue({
          ok: true,
          channel: "telegram",
          to: destinationIsCaller ? "123" : "456",
          mode: "explicit",
          sessionRoute: {
            sessionKey: destinationSessionKey,
            baseSessionKey: destinationSessionKey,
            peer: { kind: "direct", id: destinationIsCaller ? "123" : "456" },
            chatType: "direct",
            from: "telegram:123",
            to: destinationIsCaller ? "123" : "456",
          },
        });
      const job = {
        ...createCronJob({
          id: "cron-1",
          agentId: "ops",
          sessionTarget: "isolated",
          delivery: { mode: "announce", channel: "telegram", to: "123" },
        }),
        sourceConversation: {
          sessionKey: creatorIsCaller ? callerSessionKey : "agent:ops:dashboard:creator",
          sessionId: "creator",
        },
      };
      const context = createCronTestContext(job, getRuntimeConfig);
      try {
        const { respond } = await invokeCron(
          "cron.run",
          { id: "cron-1", waitTimeoutMs: 60_000 },
          { context, client: callerClient("ops", undefined, callerSessionKey) },
        );
        expect(context.cron.waitForManualRun).toHaveBeenCalledTimes(waits ? 1 : 0);
        expect(respond).toHaveBeenCalledWith(
          true,
          {
            ok: true,
            enqueued: true,
            runId: "run-1",
            processInstanceId: getGatewayProcessInstanceId(),
          },
          undefined,
        );
      } finally {
        resolveTarget.mockRestore();
      }
    },
  );
}
