import { stopOpenClawChrome } from "./chrome.js";
import type { ResolvedBrowserConfig } from "./config.js";
import { resolveProfile } from "./config.js";
import {
  ensureChromeExtensionRelayServer,
  stopChromeExtensionRelayServer,
} from "./extension-relay.js";
import {
  type BrowserServerState,
  createBrowserRouteContext,
  listKnownProfileNames,
} from "./server-context.js";

export async function ensureExtensionRelayForProfiles(params: {
  resolved: ResolvedBrowserConfig;
  onWarn: (message: string) => void;
}) {
  for (const name of Object.keys(params.resolved.profiles)) {
    const profile = resolveProfile(params.resolved, name);
    if (!profile || profile.driver !== "extension") {
      continue;
    }
    await ensureChromeExtensionRelayServer({
      cdpUrl: profile.cdpUrl,
      bindHost: params.resolved.relayBindHost,
    }).catch((err) => {
      params.onWarn(`Chrome extension relay init failed for profile "${name}": ${String(err)}`);
    });
  }
}

export async function stopKnownBrowserProfiles(params: {
  getState: () => BrowserServerState | null;
  onWarn: (message: string) => void;
}) {
  const current = params.getState();
  if (!current) {
    return;
  }
  const ctx = createBrowserRouteContext({
    getState: params.getState,
    refreshConfigFromDisk: true,
  });
  try {
    for (const name of listKnownProfileNames(current)) {
      try {
        const runtime = current.profiles.get(name);
        if (runtime?.running) {
          await stopOpenClawChrome(runtime.running);
          runtime.running = null;
          continue;
        }
        if (runtime?.profile.driver === "extension") {
          await stopChromeExtensionRelayServer({ cdpUrl: runtime.profile.cdpUrl }).catch(
            () => false,
          );
          continue;
        }
        await ctx.forProfile(name).stopRunningBrowser();
      } catch {
        // ignore
      }
    }
  } catch (err) {
    params.onWarn(`openclaw browser stop failed: ${String(err)}`);
  }
}
