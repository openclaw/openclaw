import { note } from "../../packages/terminal-core/src/note.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadBundledPluginPublicSurfaceModuleSyncCore } from "../plugin-sdk/facade-loader.js";

type BrowserDoctorDeps = {
  noteFn?: typeof note;
};

type BrowserNativeHostRepairResult = {
  status?: "repaired" | "skipped" | "failed";
  reason?: string;
  changes: string[];
  warnings: string[];
};

type BrowserDoctorSurface = {
  noteChromeMcpBrowserReadiness: (cfg: OpenClawConfig, deps?: BrowserDoctorDeps) => Promise<void>;
  maybeRepairOwnedChromeExtensionNativeHosts?: () => Promise<BrowserNativeHostRepairResult>;
};

function loadBrowserDoctorSurface(): BrowserDoctorSurface {
  return loadBundledPluginPublicSurfaceModuleSyncCore<BrowserDoctorSurface>({
    dirName: "browser",
    artifactBasename: "browser-doctor.js",
  });
}

export async function maybeRepairOwnedChromeExtensionNativeHosts(): Promise<BrowserNativeHostRepairResult> {
  try {
    const repair = loadBrowserDoctorSurface().maybeRepairOwnedChromeExtensionNativeHosts;
    return repair ? await repair() : { changes: [], warnings: [] };
  } catch (error) {
    return {
      changes: [],
      warnings: [
        `Browser extension native-host repair is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

export async function noteChromeMcpBrowserReadiness(cfg: OpenClawConfig, deps?: BrowserDoctorDeps) {
  try {
    await loadBrowserDoctorSurface().noteChromeMcpBrowserReadiness(cfg, deps);
  } catch (error) {
    const noteFn = deps?.noteFn ?? note;
    const message = error instanceof Error ? error.message : String(error);
    noteFn(`- Browser health check is unavailable: ${message}`, "Browser");
  }
}
