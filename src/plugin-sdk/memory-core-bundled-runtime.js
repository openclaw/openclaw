import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";
function loadApiFacadeModule() {
    return loadBundledPluginPublicSurfaceModuleSync({
        dirName: "memory-core",
        artifactBasename: "api.js",
    });
}
function loadRuntimeFacadeModule() {
    return loadBundledPluginPublicSurfaceModuleSync({
        dirName: "memory-core",
        artifactBasename: "runtime-api.js",
    });
}
export const createEmbeddingProvider = ((...args) => loadRuntimeFacadeModule().createEmbeddingProvider(...args));
export const registerBuiltInMemoryEmbeddingProviders = ((...args) => loadRuntimeFacadeModule().registerBuiltInMemoryEmbeddingProviders(...args));
export const removeGroundedShortTermCandidates = ((...args) => loadRuntimeFacadeModule().removeGroundedShortTermCandidates(...args));
export const repairDreamingArtifacts = ((...args) => loadRuntimeFacadeModule().repairDreamingArtifacts(...args));
export const previewGroundedRemMarkdown = ((...args) => loadApiFacadeModule().previewGroundedRemMarkdown(...args));
export const dedupeDreamDiaryEntries = ((...args) => loadApiFacadeModule().dedupeDreamDiaryEntries(...args));
export const writeBackfillDiaryEntries = ((...args) => loadApiFacadeModule().writeBackfillDiaryEntries(...args));
export const removeBackfillDiaryEntries = ((...args) => loadApiFacadeModule().removeBackfillDiaryEntries(...args));
