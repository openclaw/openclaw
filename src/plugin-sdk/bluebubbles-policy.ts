// Manual facade. Keep loader boundary explicit.
type FacadeModule = typeof import("@openclaw/bluebubbles/api.js");
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "bluebubbles",
    artifactBasename: "api.js",
  });
}
export const isAllowedBlueBubblesSender: FacadeModule["isAllowedBlueBubblesSender"] = ((...args) =>
  loadFacadeModule()["isAllowedBlueBubblesSender"](
    ...args,
  )) as FacadeModule["isAllowedBlueBubblesSender"];
export const resolveBlueBubblesGroupRequireMention: FacadeModule["resolveBlueBubblesGroupRequireMention"] =
  ((...args) =>
    loadFacadeModule()["resolveBlueBubblesGroupRequireMention"](
      ...args,
    )) as FacadeModule["resolveBlueBubblesGroupRequireMention"];
export const resolveBlueBubblesGroupToolPolicy: FacadeModule["resolveBlueBubblesGroupToolPolicy"] =
  ((...args) =>
    loadFacadeModule()["resolveBlueBubblesGroupToolPolicy"](
      ...args,
    )) as FacadeModule["resolveBlueBubblesGroupToolPolicy"];
