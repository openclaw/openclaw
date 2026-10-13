import type { ChannelApprovalAdapter, ChannelApprovalCapability } from "./types.adapters.js";
import type { ChannelPlugin } from "./types.plugin.js";

export function resolveChannelApprovalCapability(
  plugin?: Pick<ChannelPlugin, "approvalCapability"> | null,
): ChannelApprovalCapability | undefined {
  return plugin?.approvalCapability;
}

export function resolveChannelApprovalAdapter(
  plugin?: Pick<ChannelPlugin, "approvalCapability"> | null,
): ChannelApprovalAdapter | undefined {
  const capability = resolveChannelApprovalCapability(plugin);
  if (!capability) {
    return undefined;
  }
  if (
    !capability.delivery &&
    !capability.nativeRuntime &&
    !capability.nativeRuntimeAsync &&
    !capability.render &&
    !capability.native &&
    !capability.nativeAsync
  ) {
    // Auth-only capabilities are valid plugin metadata but do not form a delivery adapter.
    return undefined;
  }
  return {
    describeExecApprovalSetup: capability.describeExecApprovalSetup,
    describePluginApprovalSetup: capability.describePluginApprovalSetup,
    delivery: capability.delivery,
    nativeRuntime: capability.nativeRuntime,
    nativeRuntimeAsync: capability.nativeRuntimeAsync,
    render: capability.render,
    native: capability.native,
    nativeAsync: capability.nativeAsync,
  };
}
