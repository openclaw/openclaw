// Manual facade. Keep loader boundary explicit.
type FacadeModule = typeof import("@openclaw/mattermost/api.js");
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "mattermost",
    artifactBasename: "api.js",
  });
}
export const isMattermostSenderAllowed: FacadeModule["isMattermostSenderAllowed"] = ((...args) =>
  loadFacadeModule()["isMattermostSenderAllowed"](
    ...args,
  )) as FacadeModule["isMattermostSenderAllowed"];
