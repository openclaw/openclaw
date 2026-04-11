// Manual facade. Keep loader boundary explicit.
type FacadeModule = typeof import("@openclaw/matrix/api.js");
import {
  createLazyFacadeArrayValue,
  loadBundledPluginPublicSurfaceModuleSync,
} from "./facade-loader.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "matrix",
    artifactBasename: "api.js",
  });
}
export const createMatrixThreadBindingManager: FacadeModule["createMatrixThreadBindingManager"] = ((
  ...args
) =>
  loadFacadeModule()["createMatrixThreadBindingManager"](
    ...args,
  )) as FacadeModule["createMatrixThreadBindingManager"];
export const matrixSessionBindingAdapterChannels: FacadeModule["matrixSessionBindingAdapterChannels"] =
  createLazyFacadeArrayValue(
    () =>
      loadFacadeModule()["matrixSessionBindingAdapterChannels"] as unknown as readonly unknown[],
  ) as FacadeModule["matrixSessionBindingAdapterChannels"];
export const resetMatrixThreadBindingsForTests: FacadeModule["resetMatrixThreadBindingsForTests"] =
  ((...args) =>
    loadFacadeModule()["resetMatrixThreadBindingsForTests"](
      ...args,
    )) as FacadeModule["resetMatrixThreadBindingsForTests"];
