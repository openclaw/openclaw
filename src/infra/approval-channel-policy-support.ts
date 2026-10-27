import type { ChannelApprovalCapability } from "../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Older channel plugins cannot enforce reviewer policy added by a newer host. */
export function canChannelEnforcePluginReviewerPolicy(
  cfg: OpenClawConfig,
  channel: string,
  capability:
    | Pick<ChannelApprovalCapability, "supportsScopedPluginApprovalApprovers">
    | null
    | undefined,
): boolean {
  return (
    !Object.hasOwn(cfg.approvals?.plugin ?? {}, channel) ||
    capability?.supportsScopedPluginApprovalApprovers === true
  );
}
