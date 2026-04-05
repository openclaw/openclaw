import type { Server } from "node:http";
import type { ResolvedBrowserConfig } from "./browser-config.js";
import { loadActivatedBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";

export type BrowserBridge = {
  server: Server;
  port: number;
  baseUrl: string;
  state: {
    resolved: ResolvedBrowserConfig;
  };
};

type BrowserBridgeFacadeModule = {
  startBrowserBridgeServer(params: {
    resolved: ResolvedBrowserConfig;
    host?: string;
    port?: number;
    authToken?: string;
    authPassword?: string;
    onEnsureAttachTarget?: (profile: unknown) => Promise<void>;
    resolveSandboxNoVncToken?: (token: string) => { noVncPort: number; password?: string } | null;
  }): Promise<BrowserBridge>;
  stopBrowserBridgeServer(server: Server): Promise<void>;
};

function loadFacadeModule(): BrowserBridgeFacadeModule {
  return loadActivatedBundledPluginPublicSurfaceModuleSync<BrowserBridgeFacadeModule>({
    dirName: "browser",
    artifactBasename: "runtime-api.js",
  });
}

export async function startBrowserBridgeServer(
  params: Parameters<BrowserBridgeFacadeModule["startBrowserBridgeServer"]>[0],
): Promise<BrowserBridge> {
  return await loadFacadeModule().startBrowserBridgeServer(params);
}

export async function stopBrowserBridgeServer(server: Server): Promise<void> {
  await loadFacadeModule().stopBrowserBridgeServer(server);
}
