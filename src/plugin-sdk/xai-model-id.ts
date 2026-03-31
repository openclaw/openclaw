import type { PluginSdkFacadeTypeMap } from "../generated/plugin-sdk-facade-type-map.generated.js";
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";

type FacadeEntry = PluginSdkFacadeTypeMap["xai"];
type FacadeModule = FacadeEntry["module"];

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "xai",
    artifactBasename: "api.js",
  });
}

export const normalizeXaiModelId: FacadeModule["normalizeXaiModelId"] = ((...args) =>
  loadFacadeModule()["normalizeXaiModelId"](...args)) as FacadeModule["normalizeXaiModelId"];
