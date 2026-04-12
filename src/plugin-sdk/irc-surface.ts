// Manual facade. Keep loader boundary explicit.
type FacadeModule = typeof import("@openclaw/irc/api.js");
import {
  createLazyFacadeObjectValue,
  loadBundledPluginPublicSurfaceModuleSync,
} from "./facade-loader.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "irc",
    artifactBasename: "api.js",
  });
}
export const ircSetupAdapter: FacadeModule["ircSetupAdapter"] = createLazyFacadeObjectValue(
  () => loadFacadeModule()["ircSetupAdapter"] as object,
) as FacadeModule["ircSetupAdapter"];
export const ircSetupWizard: FacadeModule["ircSetupWizard"] = createLazyFacadeObjectValue(
  () => loadFacadeModule()["ircSetupWizard"] as object,
) as FacadeModule["ircSetupWizard"];
export const listIrcAccountIds: FacadeModule["listIrcAccountIds"] = ((...args) =>
  loadFacadeModule()["listIrcAccountIds"](...args)) as FacadeModule["listIrcAccountIds"];
export const resolveDefaultIrcAccountId: FacadeModule["resolveDefaultIrcAccountId"] = ((...args) =>
  loadFacadeModule()["resolveDefaultIrcAccountId"](
    ...args,
  )) as FacadeModule["resolveDefaultIrcAccountId"];
export const resolveIrcAccount: FacadeModule["resolveIrcAccount"] = ((...args) =>
  loadFacadeModule()["resolveIrcAccount"](...args)) as FacadeModule["resolveIrcAccount"];
