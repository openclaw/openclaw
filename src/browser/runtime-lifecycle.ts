import type { Server } from "node:http";
import { startLocalCdpBridge } from "./cdp-bridge.js";
import { isPwAiLoaded } from "./pw-ai-state.js";
import type { BrowserServerState } from "./server-context.js";
import { ensureExtensionRelayForProfiles, stopKnownBrowserProfiles } from "./server-lifecycle.js";

export async function createBrowserRuntimeState(params: {
  resolved: BrowserServerState["resolved"];
  port: number;
  server?: Server | null;
  onWarn: (message: string) => void;
}): Promise<BrowserServerState> {
  const state: BrowserServerState = {
    server: params.server ?? null,
    port: params.port,
    resolved: params.resolved,
    profiles: new Map(),
    cdpBridge: null,
  };

  if (params.resolved.cdpBridge?.enabled && params.resolved.cdpBridge.upstreamUrl) {
    state.cdpBridge = await startLocalCdpBridge({
      upstreamUrl: params.resolved.cdpBridge.upstreamUrl,
      bindHost: params.resolved.cdpBridge.bindHost,
      port: params.resolved.cdpBridge.port,
    });
  }

  await ensureExtensionRelayForProfiles({
    resolved: params.resolved,
    onWarn: params.onWarn,
  });

  return state;
}

export async function stopBrowserRuntime(params: {
  current: BrowserServerState | null;
  getState: () => BrowserServerState | null;
  clearState: () => void;
  closeServer?: boolean;
  onWarn: (message: string) => void;
}): Promise<void> {
  if (!params.current) {
    return;
  }

  await stopKnownBrowserProfiles({
    getState: params.getState,
    onWarn: params.onWarn,
  });

  try {
    await params.current.cdpBridge?.stop();
  } catch (err) {
    params.onWarn(`Failed to stop local CDP bridge: ${String(err)}`);
  }

  if (params.closeServer && params.current.server) {
    await new Promise<void>((resolve) => {
      params.current?.server?.close(() => resolve());
    });
  }

  params.clearState();

  if (!isPwAiLoaded()) {
    return;
  }
  try {
    const mod = await import("./pw-ai.js");
    await mod.closePlaywrightBrowserConnection();
  } catch {
    // ignore
  }
}
