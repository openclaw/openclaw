export function resolveChannelExposure(meta) {
    return {
        configured: meta.exposure?.configured ?? meta.showConfigured ?? true,
        setup: meta.exposure?.setup ?? meta.showInSetup ?? true,
        docs: meta.exposure?.docs ?? true,
    };
}
export function isChannelVisibleInConfiguredLists(meta) {
    return resolveChannelExposure(meta).configured;
}
export function isChannelVisibleInSetup(meta) {
    return resolveChannelExposure(meta).setup;
}
export function isChannelVisibleInDocs(meta) {
    return resolveChannelExposure(meta).docs;
}
