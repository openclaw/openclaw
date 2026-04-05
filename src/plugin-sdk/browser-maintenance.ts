import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommandWithTimeout } from "../process/exec.js";
import { tryLoadActivatedBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";

type CloseTrackedBrowserTabsForSessions = (params: {
  sessionKeys: Array<string | undefined>;
  closeTab?: (tab: { targetId: string; baseUrl?: string; profile?: string }) => Promise<void>;
  onWarn?: (message: string) => void;
}) => Promise<number>;

type MovePathToTrash = (targetPath: string) => Promise<string>;

function createTrashCollisionSuffix(): string {
  return randomBytes(6).toString("hex");
}

export const closeTrackedBrowserTabsForSessions: CloseTrackedBrowserTabsForSessions = async (
  params,
) => {
  if (!Array.isArray(params?.sessionKeys) || params.sessionKeys.length === 0) {
    return 0;
  }
  // Session reset always attempts browser cleanup, even when browser is disabled.
  // Keep that path a no-op unless the browser runtime is actually active.
  const closeTrackedTabs = tryLoadActivatedBundledPluginPublicSurfaceModuleSync<{
    closeTrackedBrowserTabsForSessions: CloseTrackedBrowserTabsForSessions;
  }>({
    dirName: "browser",
    artifactBasename: "runtime-api.js",
  })?.closeTrackedBrowserTabsForSessions;
  if (typeof closeTrackedTabs !== "function") {
    return 0;
  }
  return await closeTrackedTabs(params);
};

export const movePathToTrash: MovePathToTrash = async (targetPath) => {
  try {
    const result = await runCommandWithTimeout(["trash", targetPath], { timeoutMs: 10_000 });
    if (result.code !== 0) {
      throw new Error(`trash exited with code ${result.code ?? "unknown"}`);
    }
    return targetPath;
  } catch {
    const homeDir = os.homedir();
    const pathRuntime = homeDir.startsWith("/") ? path.posix : path;
    const trashDir = pathRuntime.join(homeDir, ".Trash");
    await fs.mkdir(trashDir, { recursive: true });
    const base = pathRuntime.basename(targetPath);
    const timestamp = Date.now();
    let destination = pathRuntime.join(trashDir, `${base}-${timestamp}`);
    try {
      await fs.access(destination);
      destination = pathRuntime.join(
        trashDir,
        `${base}-${timestamp}-${createTrashCollisionSuffix()}`,
      );
    } catch {
      // The initial destination is free to use.
    }
    await fs.rename(targetPath, destination);
    return destination;
  }
};
