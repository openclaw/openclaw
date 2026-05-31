import { DEFAULT_CHANNEL_CONNECT_GRACE_MS } from "./channel-health-policy.js";
import type { ChannelRuntimeSnapshot } from "./server-channel-runtime.types.js";

type ChannelDeliveryReadinessLogger = {
  warn: (message: string) => void;
};

export type ChannelDeliveryReadinessWaitParams = {
  getRuntimeSnapshot: () => ChannelRuntimeSnapshot;
  timeoutMs?: number;
  pollIntervalMs?: number;
  isClosing?: () => boolean;
  log: ChannelDeliveryReadinessLogger;
};

const DEFAULT_CHANNEL_DELIVERY_READINESS_POLL_MS = 250;

function listUnconnectedConfiguredAccounts(snapshot: ChannelRuntimeSnapshot): string[] {
  const pending: string[] = [];
  const channelEntries = Object.entries(snapshot.channelAccounts).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  for (const [channelId, accounts] of channelEntries) {
    const accountEntries = Object.entries(accounts ?? {}).toSorted(([left], [right]) =>
      left.localeCompare(right),
    );
    for (const [accountId, account] of accountEntries) {
      if (account.enabled === false || account.configured === false || account.running !== true) {
        continue;
      }
      if (typeof account.connected !== "boolean") {
        continue;
      }
      if (!account.connected) {
        pending.push(`${channelId}/${accountId}`);
      }
    }
  }
  return pending;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export async function waitForConfiguredChannelDeliveryReadiness(
  params: ChannelDeliveryReadinessWaitParams,
): Promise<void> {
  const timeoutMs = Math.max(0, params.timeoutMs ?? DEFAULT_CHANNEL_CONNECT_GRACE_MS);
  const pollIntervalMs = Math.max(
    1,
    params.pollIntervalMs ?? DEFAULT_CHANNEL_DELIVERY_READINESS_POLL_MS,
  );
  const deadlineAt = Date.now() + timeoutMs;
  let pending = listUnconnectedConfiguredAccounts(params.getRuntimeSnapshot());

  while (pending.length > 0 && params.isClosing?.() !== true) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    await sleep(Math.min(pollIntervalMs, remainingMs));
    pending = listUnconnectedConfiguredAccounts(params.getRuntimeSnapshot());
  }

  if (pending.length === 0 || params.isClosing?.() === true) {
    return;
  }
  params.log.warn(
    `gateway cron starting before channel delivery readiness; unconnected channel accounts: ${pending.join(
      ", ",
    )}`,
  );
}
