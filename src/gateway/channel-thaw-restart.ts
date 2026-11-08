// Host-thaw channel restart over the public ChannelManager surface.
import type { ChannelId } from "../channels/plugins/index.js";
import { dedupeByKey } from "../shared/dedupe-by-key.js";
import type { ChannelManager } from "./server-channels.js";

type ThawRestartManager = Pick<
  ChannelManager,
  "getRuntimeSnapshot" | "isAccountListed" | "captureAccountRestart"
>;

export type ThawRestartTarget = {
  channelId: ChannelId;
  accountId: string;
  restart: NonNullable<ReturnType<ChannelManager["captureAccountRestart"]>>;
};

export type ThawRestartSelection =
  | { kind: "new-thaw"; pendingTargets?: readonly ThawRestartTarget[] }
  | { kind: "deferred-retry"; targets: readonly ThawRestartTarget[] };

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
  return dedupeByKey(
    [...current, ...pending],
    ({ channelId, accountId }) => `${channelId}:${accountId}`,
  );
}

/**
 * Restarts running listed, non-manually-stopped channel accounts after a host
 * thaw. Dead sockets from a freeze otherwise wait for the slow health sweep.
 */
export async function restartRunningChannelAccounts(
  manager: ThawRestartManager,
  opts: { shouldContinue: () => boolean; onError: (message: string) => void },
  selection: ThawRestartSelection = { kind: "new-thaw" },
): Promise<ThawRestartTarget[]> {
  const targets =
    selection.kind === "new-thaw"
      ? captureThawRestartTargets(manager, selection.pendingTargets)
      : [...selection.targets];
  const failedTargets: ThawRestartTarget[] = [];
  for (const [index, target] of targets.entries()) {
    const { channelId, accountId } = target;
    // A suspension can commit while an account stop is awaited; retain only
    // unfinished targets so successful siblings are not disrupted again.
    if (!opts.shouldContinue()) {
      return [...failedTargets, ...targets.slice(index)];
    }
    try {
      if (!(await target.restart(opts.shouldContinue))) {
        failedTargets.push(target);
      }
    } catch (error) {
      failedTargets.push(target);
      opts.onError(`[${channelId}:${accountId}] host-thaw restart failed: ${String(error)}`);
    }
    if (!opts.shouldContinue()) {
      return [...failedTargets, ...targets.slice(index + 1)];
    }
  }
  return failedTargets;
}
