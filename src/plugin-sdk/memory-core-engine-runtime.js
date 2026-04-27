import { createLazyFacadeObjectValue, loadActivatedBundledPluginPublicSurfaceModuleSync, } from "./facade-runtime.js";
function loadFacadeModule() {
    return loadActivatedBundledPluginPublicSurfaceModuleSync({
        dirName: "memory-core",
        artifactBasename: "runtime-api.js",
    });
}
export const auditShortTermPromotionArtifacts = ((...args) => loadFacadeModule()["auditShortTermPromotionArtifacts"](...args));
export const auditDreamingArtifacts = ((...args) => loadFacadeModule()["auditDreamingArtifacts"](...args));
export const getBuiltinMemoryEmbeddingProviderDoctorMetadata = ((...args) => loadFacadeModule()["getBuiltinMemoryEmbeddingProviderDoctorMetadata"](...args));
export const getMemorySearchManager = ((...args) => loadFacadeModule()["getMemorySearchManager"](...args));
export const listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata = ((...args) => loadFacadeModule()["listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata"](...args));
export const MemoryIndexManager = createLazyFacadeObjectValue(() => loadFacadeModule()["MemoryIndexManager"]);
export const repairShortTermPromotionArtifacts = ((...args) => loadFacadeModule()["repairShortTermPromotionArtifacts"](...args));
export const repairDreamingArtifacts = ((...args) => loadFacadeModule()["repairDreamingArtifacts"](...args));
