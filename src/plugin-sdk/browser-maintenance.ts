import {
  canLoadActivatedBundledPluginPublicSurface,
  tryLoadActivatedBundledPluginPublicSurfaceModuleSync,
} from "./facade-runtime.js";
export { movePathToTrash, type MovePathToTrashOptions } from "./browser-trash.js";

type CloseTrackedBrowserTabsParams = {
  /** Session keys whose tracked browser tabs should be closed; blank entries are ignored. */
  sessionKeys: Array<string | undefined>;
  /** Optional test/adapter hook used by the browser plugin surface for closing one tab. */
  closeTab?: (tab: { targetId: string; baseUrl?: string; profile?: string }) => Promise<void>;
  /** Best-effort warning hook for unavailable plugin surface or cleanup failures. */
  onWarn?: (message: string) => void;
};

type BrowserMaintenanceSurface = {
  closeTrackedBrowserTabsForSessions: (params: CloseTrackedBrowserTabsParams) => Promise<number>;
};

let cachedBrowserMaintenanceSurface: BrowserMaintenanceSurface | undefined;

function hasRequestedSessionKeys(sessionKeys: Array<string | undefined>): boolean {
  return sessionKeys.some((key) => Boolean(key?.trim()));
}

function loadBrowserMaintenanceSurface(): BrowserMaintenanceSurface | null {
  const request = {
    dirName: "browser",
    artifactBasename: "browser-maintenance.js",
  };
  if (!canLoadActivatedBundledPluginPublicSurface(request)) {
    return null;
  }
  if (!cachedBrowserMaintenanceSurface) {
    cachedBrowserMaintenanceSurface =
      tryLoadActivatedBundledPluginPublicSurfaceModuleSync<BrowserMaintenanceSurface>(request) ??
      undefined;
  }
  return cachedBrowserMaintenanceSurface ?? null;
}

/** Close browser-plugin tracked tabs for active session keys, returning zero when unavailable. */
export async function closeTrackedBrowserTabsForSessions(
  params: CloseTrackedBrowserTabsParams,
): Promise<number> {
  if (!hasRequestedSessionKeys(params.sessionKeys)) {
    return 0;
  }

  let surface: BrowserMaintenanceSurface | null;
  try {
    surface = loadBrowserMaintenanceSurface();
  } catch (error) {
    // Session lifecycle cleanup must stay best-effort; browser plugin load failures should warn,
    // not block session deletion/reset flows.
    params.onWarn?.(`browser cleanup unavailable: ${String(error)}`);
    return 0;
  }
  if (!surface) {
    return 0;
  }
  return await surface.closeTrackedBrowserTabsForSessions(params);
}
