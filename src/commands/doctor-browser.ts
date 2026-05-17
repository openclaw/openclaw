import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadBundledPluginPublicSurfaceModuleSync } from "../plugin-sdk/facade-loader.js";
import { note } from "../terminal/note.js";

type BrowserDoctorDeps = {
  platform?: NodeJS.Platform;
  noteFn?: typeof note;
  env?: NodeJS.ProcessEnv;
  getUid?: () => number;
  resolveManagedExecutable?: (
    resolved: unknown,
    platform: NodeJS.Platform,
  ) => { path: string } | null;
  resolveChromeExecutable?: (platform: NodeJS.Platform) => { path: string } | null;
  readVersion?: (executablePath: string) => string | null;
  configDir?: string;
  pathExists?: (targetPath: string) => boolean;
};

type BrowserDoctorRepairDeps = {
  env?: NodeJS.ProcessEnv;
  configDir?: string;
  pathExists?: (targetPath: string) => boolean;
  movePathToTrash?: (targetPath: string) => Promise<string>;
};

type BrowserDoctorSurface = {
  noteChromeMcpBrowserReadiness: (cfg: OpenClawConfig, deps?: BrowserDoctorDeps) => Promise<void>;
  maybeArchiveLegacyClawdBrowserProfileResidue?: (
    cfg: OpenClawConfig,
    deps?: BrowserDoctorRepairDeps,
  ) => Promise<{ changes: string[]; warnings: string[] }>;
};

function loadBrowserDoctorSurface(): BrowserDoctorSurface {
  return loadBundledPluginPublicSurfaceModuleSync<BrowserDoctorSurface>({
    dirName: "browser",
    artifactBasename: "browser-doctor.js",
  });
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

export async function maybeArchiveLegacyClawdBrowserProfileResidue(
  cfg: OpenClawConfig,
  deps?: BrowserDoctorRepairDeps,
): Promise<{ changes: string[]; warnings: string[] }> {
  try {
    const repair = loadBrowserDoctorSurface().maybeArchiveLegacyClawdBrowserProfileResidue;
    if (!repair) {
      return { changes: [], warnings: [] };
    }
    return await repair(cfg, deps);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      changes: [],
      warnings: [`Browser profile cleanup is unavailable: ${message}`],
    };
  }
}
