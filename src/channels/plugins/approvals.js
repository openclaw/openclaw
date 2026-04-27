export function resolveChannelApprovalCapability(plugin) {
    return plugin?.approvalCapability;
}
export function resolveChannelApprovalAdapter(plugin) {
    const capability = resolveChannelApprovalCapability(plugin);
    if (!capability) {
        return undefined;
    }
    if (!capability.delivery &&
        !capability.nativeRuntime &&
        !capability.render &&
        !capability.native) {
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
