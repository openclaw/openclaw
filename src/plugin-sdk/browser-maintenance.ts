/**
 * Public SDK facade for browser cleanup and trash operations.
 */
import type { SessionEntryCurrentPreparation } from "../config/sessions/session-entry-current.types.js";
import { tryLoadActivatedBundledPluginPublicSurfaceModule } from "./facade-runtime.js";
export { movePathToTrash, type MovePathToTrashOptions } from "./browser-trash.js";

type CloseTrackedBrowserTabsParams = SessionEntryCurrentPreparation & {
  sessionKeys: Array<string | undefined>;
  /** Gates new cleanup claims; already claimed tabs retain their cleanup owner. */
  isCurrent?: () => boolean;
  closeTab?: (tab: { targetId: string; baseUrl?: string; profile?: string }) => Promise<void>;
  onWarn?: (message: string) => void;
};

type BrowserMaintenanceSurface = {
  supportsSessionEntryCurrent?: true;
  closeTrackedBrowserTabsForSessions: (params: CloseTrackedBrowserTabsParams) => Promise<number>;
};

function hasRequestedSessionKeys(sessionKeys: Array<string | undefined>): boolean {
  return sessionKeys.some((key) => Boolean(key?.trim()));
}

/** Closes tracked browser tabs for requested session keys when the browser plugin is active. */
export async function closeTrackedBrowserTabsForSessions(
  params: CloseTrackedBrowserTabsParams,
): Promise<number> {
  if (params.sessionEntryCurrent && typeof params.prepareCurrent !== "function") {
    params.onWarn?.("browser cleanup unavailable: sessionEntryCurrent requires prepareCurrent");
    return 0;
  }
  if (params.isCurrent?.() === false || !hasRequestedSessionKeys(params.sessionKeys)) {
    return 0;
  }

  let surface: BrowserMaintenanceSurface | null;
  try {
    // Cleanup is already async; keep cold activation off the synchronous source loader.
    surface = await tryLoadActivatedBundledPluginPublicSurfaceModule<BrowserMaintenanceSurface>({
      dirName: "browser",
      artifactBasename: "browser-maintenance.js",
    });
  } catch (error) {
    params.onWarn?.(`browser cleanup unavailable: ${String(error)}`);
    return 0;
  }
  if (!surface || params.isCurrent?.() === false) {
    return 0;
  }
  if (
    (params.prepareCurrent || params.sessionEntryCurrent) &&
    surface.supportsSessionEntryCurrent !== true
  ) {
    params.onWarn?.(
      "browser cleanup unavailable: update the Browser plugin to support session-current cleanup",
    );
    return 0;
  }
  if (params.prepareCurrent) {
    if (!(await params.prepareCurrent()) || params.isCurrent?.() === false) {
      return 0;
    }
  }
  return await surface.closeTrackedBrowserTabsForSessions(params);
}
