import { resolveGatewayAuth } from "../gateway/auth.js";
import type { OpenClawConfig } from "./browser-support.js";

export type BrowserControlAuth = {
  token?: string;
  password?: string;
};

export function resolveBrowserControlAuth(
  cfg: OpenClawConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): BrowserControlAuth {
  const auth = resolveGatewayAuth({
    authConfig: cfg?.gateway?.auth,
    env,
    tailscaleMode: cfg?.gateway?.tailscale?.mode,
  });
  const token = typeof auth.token === "string" ? auth.token.trim() : "";
  const password = typeof auth.password === "string" ? auth.password.trim() : "";
  return {
    token: token || undefined,
    password: password || undefined,
  };
}

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
