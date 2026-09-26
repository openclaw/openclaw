import { createGatewayActiveWorkSnapshot } from "../infra/gateway-active-work.js";
import { resolveGatewayRestartDeferralTimeoutMs } from "../infra/restart-budget.js";
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
    const details = [];
    if (counts.queueSize > 0) {
      details.push(`${counts.queueSize} operation(s)`);
    }
    if (counts.pendingReplies > 0) {
      details.push(`${counts.pendingReplies} reply(ies)`);
    }
    if (counts.embeddedRuns > 0) {
      details.push(`${counts.embeddedRuns} embedded run(s)`);
    }
    if (counts.backgroundExecSessions > 0) {
      details.push(`${counts.backgroundExecSessions} background exec session(s)`);
    }
    if (counts.rootRequests > 0) {
      details.push(`${counts.rootRequests} gateway request(s)`);
    }
    if (counts.agentRuns > 0) {
      details.push(`${counts.agentRuns} admitted agent run(s)`);
    }
    if (counts.acpRuns > 0) {
      details.push(`${counts.acpRuns} ACP turn(s)`);
    }
    if (counts.mediaRuns > 0) {
      details.push(`${counts.mediaRuns} media generation(s)`);
    }
    if (counts.cronRuns > 0) {
      details.push(`${counts.cronRuns} cron run(s)`);
    }
    return details;
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
