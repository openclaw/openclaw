import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveMatrixSender, withMatrixChannel } from "./deliver.matrix-sender.test-support.js";
import { drainPendingDeliveriesCore, type DeliverFn } from "./delivery-queue-recovery.js";
import { createRecoveryLog } from "./delivery-queue.test-helpers.js";

export const boundedCronCompletionRetention = {
  idPrefix: "cron-direct-delivery:v1:",
  maxAgeMs: 24 * 60 * 60_000,
  maxEntries: 2_000,
} as const;

export const matrixOutboundForQueueTest: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async ({ cfg, to, text, accountId, deps, onPlatformSendDispatch }) => {
    await onPlatformSendDispatch?.();
    return withMatrixChannel(
      await resolveMatrixSender(deps)(to, text, {
        cfg,
        accountId: accountId ?? undefined,
      }),
    );
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId, deps, onPlatformSendDispatch }) => {
    await onPlatformSendDispatch?.();
    return withMatrixChannel(
      await resolveMatrixSender(deps)(to, text ?? "", {
        cfg,
        accountId: accountId ?? undefined,
        mediaUrl,
      }),
    );
  },
};

export async function drainMatrixReconnect(opts: {
  deliver: DeliverFn;
  stateDir: string;
  shouldContinue?: () => boolean;
}): Promise<void> {
  await drainPendingDeliveriesCore({
    drainKey: "matrix:reconnect-test",
    logLabel: "Matrix reconnect drain",
    cfg: {} as OpenClawConfig,
    log: createRecoveryLog(),
    stateDir: opts.stateDir,
    deliver: opts.deliver,
    selectEntry: (entry) => ({ match: entry.channel === "matrix", bypassBackoff: true }),
    ...(opts.shouldContinue ? { shouldContinue: opts.shouldContinue } : {}),
  });
}
