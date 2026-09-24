import { createRuntimeConfigReader } from "../config/runtime-snapshot.js";
/**
 * Runtime SDK subpath for approval auth adapters and same-chat authorization markers.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { UserChannelIdentity } from "../state/user-profiles.types.js";
export { resolveApprovalApprovers } from "./approval-approvers.js";
export {
  createChannelApprovalAuth,
  createResolvedApproverActionAuthAdapter,
  isImplicitSameChatApprovalAuthorization,
  markImplicitSameChatApprovalAuthorization,
} from "./approval-auth-helpers.js";

/** Prepare a linked person's current approval permission without granting channel-wide authority. */
export async function prepareChannelApprovalAuthority(
  params: { cfg: OpenClawConfig } & UserChannelIdentity,
): Promise<{ assertCurrent: () => void } | undefined> {
  const { prepareChannelOperatorAuthority } =
    await import("../gateway/channel-operator-authority.js");
  const { cfg, channelId, accountId, senderId } = params;
  const authority = await prepareChannelOperatorAuthority(cfg, { channelId, accountId, senderId });
  if (
    !authority ||
    !authority.scopes.some((scope) => scope === "operator.admin" || scope === "operator.approvals")
  ) {
    return undefined;
  }
  const currentConfig = createRuntimeConfigReader(cfg);
  return {
    assertCurrent: () => {
      if (!authority.isCurrent(currentConfig())) {
        throw new Error("Channel approval authority changed");
      }
    },
  };
}
