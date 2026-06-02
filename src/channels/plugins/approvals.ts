import type { ChannelApprovalAdapter, ChannelApprovalCapability } from "./types.adapters.js";
import type { ChannelPlugin } from "./types.plugin.js";

/** Returns the raw approval capability advertised by a channel plugin. */
export function resolveChannelApprovalCapability(
  plugin?: Pick<ChannelPlugin, "approvalCapability"> | null,
): ChannelApprovalCapability | undefined {
  return plugin?.approvalCapability;
}

/**
 * Converts a channel approval capability into an adapter only when it exposes at
 * least one executable approval surface.
 */
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
    !capability.render &&
    !capability.native
  ) {
    // A setup-description-only capability is useful metadata, but it is not an
    // adapter the runtime can invoke for approval handling.
    return undefined;
  }
  return {
    describeExecApprovalSetup: capability.describeExecApprovalSetup,
    delivery: capability.delivery,
    nativeRuntime: capability.nativeRuntime,
    render: capability.render,
    native: capability.native,
  };
}
