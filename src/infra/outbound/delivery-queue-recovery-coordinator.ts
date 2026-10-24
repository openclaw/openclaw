import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createDeliveryRecoveryCoordinator,
  type ActiveDeliveryRecoveryClaimResult,
} from "../delivery-recovery.shared.js";
import type { QueuedDelivery } from "./delivery-queue-types.js";
import { buildChannelAccountKey } from "./session-binding-normalization.js";

// Live claims and every background scan must share this one queue owner.
export const recoveryCoordinator = createDeliveryRecoveryCoordinator<QueuedDelivery>({
  maxConcurrentLanes: 4,
});

export function recoveryLaneKey(
  entry: QueuedDelivery,
  cfg: OpenClawConfig,
  stateDir: string,
): string {
  const plugin = getChannelPlugin(entry.channel);
  const accountId =
    entry.accountId?.trim() ||
    (plugin ? resolveChannelDefaultAccountId({ plugin, cfg }) : "default");
  return JSON.stringify([
    stateDir,
    buildChannelAccountKey({ channel: plugin?.id ?? entry.channel, accountId }),
  ]);
}

export async function withActiveDeliveryClaim<T>(
  entryId: string,
  fn: () => Promise<T>,
): Promise<ActiveDeliveryRecoveryClaimResult<T>> {
  return recoveryCoordinator.withClaim(entryId, fn);
}
