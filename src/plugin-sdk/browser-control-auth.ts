export type { BrowserControlAuth } from "./browser-config.js";
export { resolveBrowserControlAuth } from "./browser-config.js";
type BrowserControlAuthModule = typeof import("@openclaw/browser/browser-control-auth.js");
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";

function loadBrowserControlAuthModule(): BrowserControlAuthModule {
  return loadBundledPluginPublicSurfaceModuleSync<BrowserControlAuthModule>({
    dirName: "browser",
    artifactBasename: "browser-control-auth.js",
  });
}

export const ensureBrowserControlAuth: BrowserControlAuthModule["ensureBrowserControlAuth"] = ((
  ...args
) =>
  loadBrowserControlAuthModule().ensureBrowserControlAuth(
    ...args,
  )) as BrowserControlAuthModule["ensureBrowserControlAuth"];
