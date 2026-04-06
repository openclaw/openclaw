// Manual facade. Keep loader boundary explicit.
type FacadeModule = typeof import("@openclaw/matrix/runtime-api.js");
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "matrix",
    artifactBasename: "runtime-api.js",
  });
}

export const ensureMatrixSdkInstalled: FacadeModule["ensureMatrixSdkInstalled"] = ((...args) =>
  loadFacadeModule().ensureMatrixSdkInstalled(...args)) as FacadeModule["ensureMatrixSdkInstalled"];
export const isMatrixSdkAvailable: FacadeModule["isMatrixSdkAvailable"] = ((...args) =>
  loadFacadeModule().isMatrixSdkAvailable(...args)) as FacadeModule["isMatrixSdkAvailable"];
