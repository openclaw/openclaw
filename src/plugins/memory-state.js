const memoryPluginState = {
    corpusSupplements: [],
    promptSupplements: [],
};
export function registerMemoryCorpusSupplement(pluginId, supplement) {
    const next = memoryPluginState.corpusSupplements.filter((registration) => registration.pluginId !== pluginId);
    next.push({ pluginId, supplement });
    memoryPluginState.corpusSupplements = next;
}
export function registerMemoryCapability(pluginId, capability) {
    memoryPluginState.capability = { pluginId, capability: { ...capability } };
}
export function getMemoryCapabilityRegistration() {
    return memoryPluginState.capability
        ? {
            pluginId: memoryPluginState.capability.pluginId,
            capability: { ...memoryPluginState.capability.capability },
        }
        : undefined;
}
export function listMemoryCorpusSupplements() {
    return [...memoryPluginState.corpusSupplements];
}
/** @deprecated Use registerMemoryCapability(pluginId, { promptBuilder }) instead. */
export function registerMemoryPromptSection(builder) {
    memoryPluginState.promptBuilder = builder;
}
export function registerMemoryPromptSupplement(pluginId, builder) {
    const next = memoryPluginState.promptSupplements.filter((registration) => registration.pluginId !== pluginId);
    next.push({ pluginId, builder });
    memoryPluginState.promptSupplements = next;
}
export function buildMemoryPromptSection(params) {
    const primary = memoryPluginState.capability?.capability.promptBuilder?.(params) ??
        memoryPluginState.promptBuilder?.(params) ??
        [];
    const supplements = memoryPluginState.promptSupplements
        // Keep supplement order stable even if plugin registration order changes.
        .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId))
        .flatMap((registration) => registration.builder(params));
    return [...primary, ...supplements];
}
export function getMemoryPromptSectionBuilder() {
    return memoryPluginState.capability?.capability.promptBuilder ?? memoryPluginState.promptBuilder;
}
export function listMemoryPromptSupplements() {
    return [...memoryPluginState.promptSupplements];
}
/** @deprecated Use registerMemoryCapability(pluginId, { flushPlanResolver }) instead. */
export function registerMemoryFlushPlanResolver(resolver) {
    memoryPluginState.flushPlanResolver = resolver;
}
export function resolveMemoryFlushPlan(params) {
    return (memoryPluginState.capability?.capability.flushPlanResolver?.(params) ??
        memoryPluginState.flushPlanResolver?.(params) ??
        null);
}
export function getMemoryFlushPlanResolver() {
    return (memoryPluginState.capability?.capability.flushPlanResolver ??
        memoryPluginState.flushPlanResolver);
}
/** @deprecated Use registerMemoryCapability(pluginId, { runtime }) instead. */
export function registerMemoryRuntime(runtime) {
    memoryPluginState.runtime = runtime;
}
export function getMemoryRuntime() {
    return memoryPluginState.capability?.capability.runtime ?? memoryPluginState.runtime;
}
export function hasMemoryRuntime() {
    return getMemoryRuntime() !== undefined;
}
function cloneMemoryPublicArtifact(artifact) {
    return {
        ...artifact,
        agentIds: [...artifact.agentIds],
    };
}
export async function listActiveMemoryPublicArtifacts(params) {
    const artifacts = (await memoryPluginState.capability?.capability.publicArtifacts?.listArtifacts(params)) ?? [];
    return artifacts.map(cloneMemoryPublicArtifact).toSorted((left, right) => {
        const workspaceOrder = left.workspaceDir.localeCompare(right.workspaceDir);
        if (workspaceOrder !== 0) {
            return workspaceOrder;
        }
        const relativePathOrder = left.relativePath.localeCompare(right.relativePath);
        if (relativePathOrder !== 0) {
            return relativePathOrder;
        }
        const kindOrder = left.kind.localeCompare(right.kind);
        if (kindOrder !== 0) {
            return kindOrder;
        }
        const contentTypeOrder = left.contentType.localeCompare(right.contentType);
        if (contentTypeOrder !== 0) {
            return contentTypeOrder;
        }
        const agentOrder = left.agentIds.join("\0").localeCompare(right.agentIds.join("\0"));
        if (agentOrder !== 0) {
            return agentOrder;
        }
        return left.absolutePath.localeCompare(right.absolutePath);
    });
}
export function restoreMemoryPluginState(state) {
    memoryPluginState.capability = state.capability
        ? {
            pluginId: state.capability.pluginId,
            capability: { ...state.capability.capability },
        }
        : undefined;
    memoryPluginState.corpusSupplements = [...state.corpusSupplements];
    memoryPluginState.promptBuilder = state.promptBuilder;
    memoryPluginState.promptSupplements = [...state.promptSupplements];
    memoryPluginState.flushPlanResolver = state.flushPlanResolver;
    memoryPluginState.runtime = state.runtime;
}
export function clearMemoryPluginState() {
    memoryPluginState.capability = undefined;
    memoryPluginState.corpusSupplements = [];
    memoryPluginState.promptBuilder = undefined;
    memoryPluginState.promptSupplements = [];
    memoryPluginState.flushPlanResolver = undefined;
    memoryPluginState.runtime = undefined;
}
export const _resetMemoryPluginState = clearMemoryPluginState;
