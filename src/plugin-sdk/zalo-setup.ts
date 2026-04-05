// Manual facade. Keep loader boundary explicit.
type FacadeModule = typeof import("@openclaw/zalo/api.js");
import {
  createLazyFacadeObjectValue,
  loadBundledPluginPublicSurfaceModuleSync,
} from "./facade-runtime.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "zalo",
    artifactBasename: "api.js",
  });
}
export const evaluateZaloGroupAccess: FacadeModule["evaluateZaloGroupAccess"] = ((...args) =>
  loadFacadeModule()["evaluateZaloGroupAccess"](
    ...args,
  )) as FacadeModule["evaluateZaloGroupAccess"];
export const resolveZaloRuntimeGroupPolicy: FacadeModule["resolveZaloRuntimeGroupPolicy"] = ((
  ...args
) =>
  loadFacadeModule()["resolveZaloRuntimeGroupPolicy"](
    ...args,
  )) as FacadeModule["resolveZaloRuntimeGroupPolicy"];
export const zaloSetupAdapter: FacadeModule["zaloSetupAdapter"] = createLazyFacadeObjectValue(
  () => loadFacadeModule()["zaloSetupAdapter"] as object,
) as FacadeModule["zaloSetupAdapter"];
export const zaloSetupWizard: FacadeModule["zaloSetupWizard"] = createLazyFacadeObjectValue(
  () => loadFacadeModule()["zaloSetupWizard"] as object,
) as FacadeModule["zaloSetupWizard"];
