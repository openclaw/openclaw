import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PluginSdkFacadeTypeMap } from "../generated/plugin-sdk-facade-type-map.generated.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { tryLoadActivatedBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";

type BrowserRuntimeModule = PluginSdkFacadeTypeMap["browser-runtime"]["module"];

function createTrashCollisionSuffix(): string {
  return randomBytes(6).toString("hex");
}

export const closeTrackedBrowserTabsForSessions: BrowserRuntimeModule["closeTrackedBrowserTabsForSessions"] =
  (async (...args) => {
    // Session reset always attempts browser cleanup, even when browser is disabled.
    // Keep that path a no-op unless the browser runtime is actually active.
    const closeTrackedTabs = tryLoadActivatedBundledPluginPublicSurfaceModuleSync<
      Pick<BrowserRuntimeModule, "closeTrackedBrowserTabsForSessions">
    >({
      dirName: "browser",
      artifactBasename: "runtime-api.js",
    })?.closeTrackedBrowserTabsForSessions;
    if (typeof closeTrackedTabs !== "function") {
      return 0;
    }
    return await closeTrackedTabs(...args);
  }) as BrowserRuntimeModule["closeTrackedBrowserTabsForSessions"];

export const movePathToTrash: BrowserRuntimeModule["movePathToTrash"] = (async (...args) => {
  const [targetPath] = args;
  try {
    const result = await runCommandWithTimeout(["trash", targetPath], { timeoutMs: 10_000 });
    if (result.code !== 0) {
      throw new Error(`trash exited with code ${result.code ?? "unknown"}`);
    }
    return targetPath;
  } catch {
    const trashDir = path.join(os.homedir(), ".Trash");
    await fs.mkdir(trashDir, { recursive: true });
    const base = path.basename(targetPath);
    const timestamp = Date.now();
    let destination = path.join(trashDir, `${base}-${timestamp}`);
    try {
      await fs.access(destination);
      destination = path.join(trashDir, `${base}-${timestamp}-${createTrashCollisionSuffix()}`);
    } catch {
      // The initial destination is free to use.
    }
    await fs.rename(targetPath, destination);
    return destination;
  }
}) as BrowserRuntimeModule["movePathToTrash"];
