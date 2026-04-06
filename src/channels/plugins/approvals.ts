import type { ChannelApprovalAdapter, ChannelApprovalCapability, ChannelPlugin } from "./types.js";

function buildApprovalCapabilityFromLegacyPlugin(
  plugin?: Pick<ChannelPlugin, "auth" | "approvals"> | null,
): ChannelApprovalCapability | undefined {
  const authorizeActorAction = plugin?.auth?.authorizeActorAction;
  const getActionAvailabilityState = plugin?.auth?.getActionAvailabilityState;
  const resolveApproveCommandBehavior = plugin?.auth?.resolveApproveCommandBehavior;
  const approvals = plugin?.approvals;
  if (
    !authorizeActorAction &&
    !getActionAvailabilityState &&
    !resolveApproveCommandBehavior &&
    !approvals?.describeExecApprovalSetup &&
    !approvals?.delivery &&
    !approvals?.render &&
    !approvals?.native
  ) {
    return undefined;
  }
  return {
    authorizeActorAction,
    getActionAvailabilityState,
    resolveApproveCommandBehavior,
    describeExecApprovalSetup: approvals?.describeExecApprovalSetup,
    delivery: approvals?.delivery,
    render: approvals?.render,
    native: approvals?.native,
  };
}

export function resolveChannelApprovalCapability(
  plugin?: Pick<ChannelPlugin, "approvalCapability" | "auth" | "approvals"> | null,
): ChannelApprovalCapability | undefined {
  const capability = plugin?.approvalCapability;
  const legacyCapability = buildApprovalCapabilityFromLegacyPlugin(plugin);
  if (!capability) {
    return legacyCapability;
  }
  if (!legacyCapability) {
    return capability;
  }
  return {
    authorizeActorAction: capability.authorizeActorAction ?? legacyCapability.authorizeActorAction,
    getActionAvailabilityState:
      capability.getActionAvailabilityState ?? legacyCapability.getActionAvailabilityState,
    resolveApproveCommandBehavior:
      capability.resolveApproveCommandBehavior ?? legacyCapability.resolveApproveCommandBehavior,
    describeExecApprovalSetup:
      capability.describeExecApprovalSetup ?? legacyCapability.describeExecApprovalSetup,
    delivery: capability.delivery ?? legacyCapability.delivery,
    render: capability.render ?? legacyCapability.render,
    native: capability.native ?? legacyCapability.native,
  };
}

export function resolveChannelApprovalAdapter(
  plugin?: Pick<ChannelPlugin, "approvalCapability" | "auth" | "approvals"> | null,
): ChannelApprovalAdapter | undefined {
  const capability = resolveChannelApprovalCapability(plugin);
  if (!capability) {
    return undefined;
  }
  if (!capability.delivery && !capability.render && !capability.native) {
    return undefined;
  }
  return {
    describeExecApprovalSetup: capability.describeExecApprovalSetup,
    delivery: capability.delivery,
    render: capability.render,
    native: capability.native,
  };
}
