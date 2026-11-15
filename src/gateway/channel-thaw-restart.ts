// Host-thaw channel restart over the public ChannelManager surface.
import type { ChannelId } from "../channels/plugins/index.js";
import { dedupeByKey } from "../shared/dedupe-by-key.js";
import type { ChannelManager } from "./server-channels.js";

export type ThawRestartManager = Pick<
  ChannelManager,
  "getRuntimeSnapshot" | "isAccountListed" | "captureAccountRestart"
>;

export type ThawRestartTarget = {
  channelId: ChannelId;
  accountId: string;
  restart: NonNullable<ReturnType<ChannelManager["captureAccountRestart"]>>;
};

/** Capture affected lifetimes before active work can defer their recovery. */
export function captureThawRestartTargets(
  manager: ThawRestartManager,
  pending: readonly ThawRestartTarget[] = [],
): ThawRestartTarget[] {
  const current = Object.entries(
    manager.getRuntimeSnapshot({ inspectAccounts: false }).channelAccounts,
  ).flatMap(([channelId, accounts]) =>
    Object.entries(accounts ?? {}).flatMap(([accountId, status]) => {
      if (status?.running !== true || !manager.isAccountListed(channelId, accountId)) {
        return [];
      }
      const restart = manager.captureAccountRestart(channelId, accountId, "host-thaw");
      return restart ? [{ channelId, accountId, restart }] : [];
    }),
  );
  // A new gap affects current lifetimes; retain older incomplete stops only
  // where no current running account supersedes them.
  return dedupeByKey(
    [...current, ...pending],
    ({ channelId, accountId }) => `${channelId}:${accountId}`,
  );
}

export async function restartRunningChannelAccounts(
  targets: readonly ThawRestartTarget[],
  opts: { shouldContinue: () => boolean; onError: (message: string) => void },
): Promise<ThawRestartTarget[]> {
  const failedTargets: ThawRestartTarget[] = [];
  for (const [index, target] of targets.entries()) {
    if (!opts.shouldContinue()) {
      return [...failedTargets, ...targets.slice(index)];
    }
    try {
      if (!(await target.restart(opts.shouldContinue))) {
        failedTargets.push(target);
      }
    } catch (error) {
      failedTargets.push(target);
      opts.onError(
        `[${target.channelId}:${target.accountId}] host-thaw restart failed: ${String(error)}`,
      );
    }
  }
  return failedTargets;
}
