/**
 * Runtime SDK subpath for native approval routing, target matching, and forwarding gates.
 */
export {
  createChannelApproverDmTargetResolver,
  createChannelApproverDmTargetResolverAsync,
  createChannelNativeOriginTargetResolver,
  createChannelNativeOriginTargetResolverAsync,
  createNativeApprovalChannelRouteGates,
  createNativeApprovalChannelRouteGatesAsync,
  createNativeApprovalForwardingFallbackSuppressor,
  createNativeApprovalForwardingFallbackSuppressorAsync,
  createNativeApprovalMessagingTargetResolvers,
  nativeApprovalTargetsMatch,
  resolveApprovalKind,
  shouldSuppressLocalNativeExecApprovalPrompt,
  type ChannelApprovalExplicitTargetEligibilityParams,
  type ChannelApprovalForwardingEligibilityParams,
  type ChannelApprovalPotentialRouteParams,
} from "./approval-native-helpers.js";
export {
  resolveApprovalRequestSessionConversation,
  resolveApprovalRequestOriginTarget,
  resolveApprovalRequestOriginTargetAsync,
  resolveApprovalRequestSessionTarget,
  resolveApprovalRequestSessionTargetAsync,
  resolveExecApprovalSessionTarget,
  resolveExecApprovalSessionTargetAsync,
  type ApprovalRequestSessionConversation,
  type ExecApprovalSessionTarget,
} from "../infra/exec-approval-session-target.js";
export { buildChannelApprovalNativeTargetKey } from "../infra/approval-native-target-key.js";
export {
  doesApprovalRequestMatchChannelAccount,
  doesApprovalRequestMatchChannelAccountAsync,
  doesApprovalRequestSelectChannelAccount,
  doesApprovalRequestSelectChannelAccountAsync,
  resolveApprovalRequestAccountId,
  resolveApprovalRequestAccountIdAsync,
  resolveApprovalRequestChannelAccountId,
  resolveApprovalRequestChannelAccountIdAsync,
} from "../infra/approval-request-account-binding.js";

export {
  resolveApprovalRequestSessionDeliveryAsync,
  type ApprovalRequestSessionDelivery,
} from "../infra/approval-request-account-binding.js";
