// Manual facade. Keep loader boundary explicit.
type FacadeModule = typeof import("@openclaw/matrix/runtime-api.js");
import { loadActivatedBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";

function loadFacadeModule(): FacadeModule {
  return loadActivatedBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "matrix",
    artifactBasename: "runtime-api.js",
  });
}
export const resolveMatrixAccountStringValues: FacadeModule["resolveMatrixAccountStringValues"] = ((
  ...args
) =>
  loadFacadeModule()["resolveMatrixAccountStringValues"](
    ...args,
  )) as FacadeModule["resolveMatrixAccountStringValues"];
export const setMatrixRuntime: FacadeModule["setMatrixRuntime"] = ((...args) =>
  loadFacadeModule()["setMatrixRuntime"](...args)) as FacadeModule["setMatrixRuntime"];
