import { createGatewayActiveWorkSnapshot } from "../infra/gateway-active-work.js";
import { resolveGatewayRestartDeferralTimeoutMs } from "../infra/restart-budget.js";
import { hasPluginLifecycleLeaseDemand } from "../plugins/plugin-lifecycle-lease.js";
import type { ChannelKind } from "./config-reload-plan.js";
import type { GatewayDeferredChannelReload } from "./config-reload-status.types.js";
import type { GatewayReloadHandlerParams } from "./server-reload-contracts.js";
import {
  isCurrentGatewayReloadGeneration,
  isGatewayReloadGenerationAborted,
} from "./server-reload-generation.js";

const CHANNEL_RELOAD_DEFERRAL_POLL_MS = 500;
const CHANNEL_RELOAD_STILL_PENDING_WARN_MS = 30_000;

export function createGatewayActiveWorkTracker(options: {
  params: Pick<GatewayReloadHandlerParams, "logReload">;
  myGeneration: number;
}) {
  const { params, myGeneration } = options;
  let deferredChannelReload:
    | {
        channels: ChannelKind[];
        publicationPending: boolean;
        isCurrent: () => boolean;
      }
    | undefined;
  const getDeferredChannelReloads = (): readonly GatewayDeferredChannelReload[] => {
    if (
      !deferredChannelReload ||
      !isCurrentGatewayReloadGeneration(myGeneration) ||
      isGatewayReloadGenerationAborted(myGeneration) ||
      !deferredChannelReload.isCurrent()
    ) {
      return [];
    }
    const { channels, publicationPending } = deferredChannelReload;
    return channels.map((channel) => ({ channel, publicationPending }));
  };
  const getActiveCounts = () => createGatewayActiveWorkSnapshot().counts;
  const formatActiveDetails = (counts: ReturnType<typeof getActiveCounts>) => {
    const details = [
      [counts.queueSize, "operation(s)"],
      [counts.pendingReplies, "reply(ies)"],
      [counts.embeddedRuns, "embedded run(s)"],
      [counts.backgroundExecSessions, "background exec session(s)"],
      [counts.rootRequests, "gateway request(s)"],
      [counts.agentRuns, "admitted agent run(s)"],
      [counts.acpRuns, "ACP turn(s)"],
      [counts.mediaRuns, "media generation(s)"],
      [counts.cronRuns, "cron run(s)"],
    ] as const;
    return details.filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`);
  };
  const formatDeferredWorkStatus = (status: "active" | "still active") => {
    try {
      const details = formatActiveDetails(getActiveCounts()).join(", ");
      return `${details} ${status}`;
    } catch (err) {
      // Diagnostics must not prevent the existing timeout from forcing a restart.
      return `pending work unknown (${String(err)})`;
    }
  };
  const waitForActiveWorkBeforeChannelReload = async (
    channels: Iterable<ChannelKind>,
    isTransactionCurrent: () => boolean,
    publicationPending: boolean,
  ): Promise<boolean> => {
    // Returns true when the wait was cancelled (restart or config supersession),
    // false when active work drained or timed out and channel reload may proceed.
    if (!isTransactionCurrent()) {
      return true;
    }
    const initial = getActiveCounts();
    if (initial.totalActive <= 0) {
      return false;
    }
    const channelIds = [...new Set(channels)];
    const channelNames = channelIds.join(", ");
    const shouldProceedForLeaseDemand = (counts: ReturnType<typeof getActiveCounts>) => {
      // Watcher, plugin application, and managed secrets hold the process lease here;
      // work queued behind that lease cannot finish until this reload returns.
      if (!hasPluginLifecycleLeaseDemand()) {
        return false;
      }
      params.logReload.warn(
        `channel reload proceeding (${channelNames}) with ${formatActiveDetails(counts).join(", ")} still active: caller(s) waiting for the plugin lifecycle lease held by this reload`,
      );
      return true;
    };
    if (shouldProceedForLeaseDemand(initial)) {
      return false;
    }
    const initialDetails = formatActiveDetails(initial);
    params.logReload.warn(
      `config change requires channel reload (${channelNames}) — deferring until ${initialDetails.join(
        ", ",
      )} complete`,
    );
    const timeoutMs = resolveGatewayRestartDeferralTimeoutMs();
    const startedAt = Date.now();
    let nextStillPendingAt = startedAt + CHANNEL_RELOAD_STILL_PENDING_WARN_MS;
    const deferred = {
      channels: channelIds,
      publicationPending,
      isCurrent: isTransactionCurrent,
    };
    deferredChannelReload = deferred;
    try {
      while (true) {
        if (!isTransactionCurrent() || isGatewayReloadGenerationAborted(myGeneration)) {
          return true;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, CHANNEL_RELOAD_DEFERRAL_POLL_MS);
          timer.unref?.();
        });
        if (!isTransactionCurrent() || isGatewayReloadGenerationAborted(myGeneration)) {
          return true;
        }
        const current = getActiveCounts();
        if (current.totalActive <= 0) {
          return false;
        }
        if (shouldProceedForLeaseDemand(current)) {
          return false;
        }
        const elapsedMs = Date.now() - startedAt;
        if (timeoutMs !== undefined && elapsedMs >= timeoutMs) {
          const remaining = formatActiveDetails(current);
          params.logReload.warn(
            `channel reload timeout after ${elapsedMs}ms with ${remaining.join(
              ", ",
            )} still active; reloading channels anyway`,
          );
          return false;
        }
        if (Date.now() >= nextStillPendingAt) {
          const remaining = formatActiveDetails(current);
          params.logReload.warn(
            `channel reload still deferred after ${elapsedMs}ms with ${remaining.join(", ")} active`,
          );
          nextStillPendingAt = Date.now() + CHANNEL_RELOAD_STILL_PENDING_WARN_MS;
        }
      }
    } finally {
      // A cancelled wait must not clear a newer transaction's diagnostic lease.
      if (deferredChannelReload === deferred) {
        deferredChannelReload = undefined;
      }
    }
  };

  return {
    formatActiveDetails,
    formatDeferredWorkStatus,
    getActiveCounts,
    getDeferredChannelReloads,
    waitForActiveWorkBeforeChannelReload,
  };
}
