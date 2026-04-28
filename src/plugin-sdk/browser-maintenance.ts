import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

type CloseTrackedBrowserTabsParams = {
  sessionKeys: Array<string | undefined>;
  closeTab?: (tab: { targetId: string; baseUrl?: string; profile?: string }) => Promise<void>;
  onWarn?: (message: string) => void;
};

type BrowserMaintenanceSurface = {
  closeTrackedBrowserTabsForSessions: (params: CloseTrackedBrowserTabsParams) => Promise<number>;
};
type SecureRandomRuntime = typeof import("../infra/secure-random.js");

let cachedBrowserMaintenanceSurface: BrowserMaintenanceSurface | undefined;
let secureRandomRuntimePromise: Promise<SecureRandomRuntime> | undefined;
const TRASH_DESTINATION_COLLISION_CODES = new Set(["EEXIST", "ENOTEMPTY", "ERR_FS_CP_EEXIST"]);
const TRASH_DESTINATION_RETRY_LIMIT = 4;

function hasRequestedSessionKeys(sessionKeys: Array<string | undefined>): boolean {
  return sessionKeys.some((key) => Boolean(key?.trim()));
}

function loadBrowserMaintenanceSurface(): BrowserMaintenanceSurface {
  cachedBrowserMaintenanceSurface ??=
    loadBundledPluginPublicSurfaceModuleSync<BrowserMaintenanceSurface>({
      dirName: "browser",
      artifactBasename: "browser-maintenance.js",
    });
  return cachedBrowserMaintenanceSurface;
}

function loadSecureRandomRuntime(): Promise<SecureRandomRuntime> {
  secureRandomRuntimePromise ??= import("../infra/secure-random.js");
  return secureRandomRuntimePromise;
}

function getFsErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" ? code : undefined;
}

function isTrashDestinationCollision(error: unknown): boolean {
  const code = getFsErrorCode(error);
  return Boolean(code && TRASH_DESTINATION_COLLISION_CODES.has(code));
}

function movePathToDestination(targetPath: string, dest: string): boolean {
  try {
    fs.renameSync(targetPath, dest);
    return true;
  } catch (error) {
    if (getFsErrorCode(error) !== "EXDEV") {
      if (isTrashDestinationCollision(error)) {
        return false;
      }
      throw error;
    }
  }

  try {
    fs.cpSync(targetPath, dest, { recursive: true, force: false, errorOnExist: true });
    fs.rmSync(targetPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (isTrashDestinationCollision(error)) {
      return false;
    }
    throw error;
  }
}

export async function closeTrackedBrowserTabsForSessions(
  params: CloseTrackedBrowserTabsParams,
): Promise<number> {
  if (!hasRequestedSessionKeys(params.sessionKeys)) {
    return 0;
  }

  let surface: BrowserMaintenanceSurface;
  try {
    surface = loadBrowserMaintenanceSurface();
  } catch (error) {
    params.onWarn?.(`browser cleanup unavailable: ${String(error)}`);
    return 0;
  }
  return await surface.closeTrackedBrowserTabsForSessions(params);
}

export async function movePathToTrash(targetPath: string): Promise<string> {
  // Avoid resolving external trash helpers through the service PATH during cleanup.
  const trashDir = path.join(os.homedir(), ".Trash");
  fs.mkdirSync(trashDir, { recursive: true });
  const base = path.basename(targetPath);
  const timestamp = Date.now();
  const baseDest = path.join(trashDir, `${base}-${timestamp}`);
  if (!fs.existsSync(baseDest) && movePathToDestination(targetPath, baseDest)) {
    return baseDest;
  }

  const { generateSecureToken } = await loadSecureRandomRuntime();
  for (let attempt = 0; attempt < TRASH_DESTINATION_RETRY_LIMIT; attempt += 1) {
    const dest = path.join(trashDir, `${base}-${timestamp}-${generateSecureToken(6)}`);
    if (!fs.existsSync(dest) && movePathToDestination(targetPath, dest)) {
      return dest;
    }
  }

  throw new Error(`Unable to choose a unique trash destination for ${targetPath}`);
}
