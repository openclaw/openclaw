import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import { getActiveEmbeddedRunCount } from "../agents/pi-embedded-runner/runs.js";
import { getTotalPendingReplies } from "../auto-reply/reply/dispatcher-registry.js";
import type { OpenClawConfig } from "../config/config.js";
import { getTotalQueueSize } from "../process/command-queue.js";

export type GatewayRestartDeferralCounts = {
  queueSize: number;
  pendingReplies: number;
  embeddedRuns: number;
  acpActiveTurns: number;
  acpQueueDepth: number;
  acpTurns: number;
  totalActive: number;
};

export function getGatewayRestartDeferralCounts(cfg: OpenClawConfig): GatewayRestartDeferralCounts {
  const queueSize = getTotalQueueSize();
  const pendingReplies = getTotalPendingReplies();
  const embeddedRuns = getActiveEmbeddedRunCount();
  const acpSnapshot = getAcpSessionManager().getObservabilitySnapshot(cfg);
  const acpActiveTurns = acpSnapshot.turns.active;
  const acpQueueDepth = acpSnapshot.turns.queueDepth;
  // ACP queueDepth can already include the active turn, so use the higher watermark
  // instead of double-counting active + queued work.
  const acpTurns = Math.max(acpActiveTurns, acpQueueDepth);

  return {
    queueSize,
    pendingReplies,
    embeddedRuns,
    acpActiveTurns,
    acpQueueDepth,
    acpTurns,
    totalActive: queueSize + pendingReplies + embeddedRuns + acpTurns,
  };
}

export function formatGatewayRestartDeferralDetails(
  counts: GatewayRestartDeferralCounts,
): string[] {
  const details: string[] = [];
  if (counts.queueSize > 0) {
    details.push(`${counts.queueSize} operation(s)`);
  }
  if (counts.pendingReplies > 0) {
    details.push(`${counts.pendingReplies} reply(ies)`);
  }
  if (counts.embeddedRuns > 0) {
    details.push(`${counts.embeddedRuns} embedded run(s)`);
  }
  if (counts.acpTurns > 0) {
    details.push(`${counts.acpTurns} ACP turn(s)`);
  }
  return details;
}
