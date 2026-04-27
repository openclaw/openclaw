let activeRuntimeWebToolsMetadata = null;
export function clearActiveRuntimeWebToolsMetadata() {
    activeRuntimeWebToolsMetadata = null;
}
export function setActiveRuntimeWebToolsMetadata(metadata) {
    activeRuntimeWebToolsMetadata = structuredClone(metadata);
}
export function getActiveRuntimeWebToolsMetadata() {
    if (!activeRuntimeWebToolsMetadata) {
        return null;
    }
    return structuredClone(activeRuntimeWebToolsMetadata);
}
