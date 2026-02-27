import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type PackageManagerSpec = {
  command: string;
  installArgs: string[];
};

// Priority order for PM detection. --ignore-scripts prevents untrusted postinstall
// from running inside bundled extensions. Matches install-package-dir.ts conventions.
const PM_CASCADE: PackageManagerSpec[] = [
  { command: "npm", installArgs: ["install", "--omit=dev", "--silent", "--ignore-scripts"] },
  { command: "pnpm", installArgs: ["install", "--prod", "--ignore-scripts", "--silent"] },
  { command: "yarn", installArgs: ["install", "--production", "--ignore-scripts", "--silent"] },
  { command: "bun", installArgs: ["install", "--production", "--ignore-scripts"] },
];

const INSTALL_TIMEOUT_MS = 300_000;

const INSTALL_ENV = {
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  NPM_CONFIG_FUND: "false",
};

// Three-state cache: undefined = not probed, null = probed and none found, object = found.
let cachedPm: PackageManagerSpec | null | undefined;

/**
 * Check whether any `dependencies` entries in the extension's package.json
 * are missing from its local node_modules.
 */
export function hasMissingDependenciesSync(packageDir: string): boolean {
  const manifestPath = path.join(packageDir, "package.json");
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf-8");
  } catch {
    return false;
  }

  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    manifest = parsed as Record<string, unknown>;
  } catch {
    return false;
  }

  const deps = manifest.dependencies;
  if (!deps || typeof deps !== "object" || Array.isArray(deps)) {
    return false;
  }

  const depNames = Object.keys(deps as Record<string, unknown>);
  if (depNames.length === 0) {
    return false;
  }

  const nodeModules = path.join(packageDir, "node_modules");
  for (const dep of depNames) {
    // Scoped packages: @scope/pkg -> node_modules/@scope/pkg
    if (!fs.existsSync(path.join(nodeModules, dep))) {
      return true;
    }
  }
  return false;
}

/**
 * Probe PATH for the first available package manager.
 * Result is cached for the lifetime of the process.
 */
export function detectAvailablePackageManagerSync(): PackageManagerSpec | null {
  if (cachedPm !== undefined) {
    return cachedPm;
  }

  for (const pm of PM_CASCADE) {
    try {
      const result = spawnSync(pm.command, ["--version"], {
        timeout: 5_000,
        stdio: "ignore",
      });
      if (result.status === 0) {
        cachedPm = pm;
        return pm;
      }
    } catch {
      // Not available — try next
    }
  }

  cachedPm = null;
  return null;
}

/** Reset the cached PM detection result. For tests only. */
export function resetPackageManagerCache(): void {
  cachedPm = undefined;
}

type EnsureResult = { ok: true } | { ok: false; error: string };

/**
 * Ensure a bundled extension's npm dependencies are installed (sync).
 * Checks for missing deps via existsSync, then runs a synchronous PM install
 * if needed. Returns `{ ok: true }` on success or skip, `{ ok: false, error }`
 * on failure. Called from the plugin loader before jiti loads the module.
 */
export function ensureExtensionDepsSync(params: {
  packageDir: string;
  pluginId: string;
  logger: { info?: (msg: string) => void; error?: (msg: string) => void };
}): EnsureResult {
  if (!hasMissingDependenciesSync(params.packageDir)) {
    return { ok: true };
  }

  const pm = detectAvailablePackageManagerSync();
  if (!pm) {
    return { ok: false, error: "no package manager found on PATH (need npm, pnpm, yarn, or bun)" };
  }

  params.logger.info?.(`[plugins] ${params.pluginId}: installing dependencies with ${pm.command}…`);

  const result = spawnSync(pm.command, pm.installArgs, {
    cwd: params.packageDir,
    timeout: INSTALL_TIMEOUT_MS,
    env: { ...process.env, ...INSTALL_ENV },
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim() ?? "";
    const stdout = result.stdout?.toString().trim() ?? "";
    const detail = stderr || stdout || `exit code ${result.status}`;
    return { ok: false, error: `${pm.command} install failed: ${detail}` };
  }

  return { ok: true };
}

/**
 * Ensure a bundled extension's npm dependencies are installed (async).
 * Same logic as the sync variant but uses `execFile` for non-blocking install.
 * Called from `openclaw extensions enable` for first-enable UX with a spinner.
 */
export async function ensureExtensionDepsAsync(params: {
  packageDir: string;
  pluginId: string;
}): Promise<EnsureResult> {
  if (!hasMissingDependenciesSync(params.packageDir)) {
    return { ok: true };
  }

  const pm = detectAvailablePackageManagerSync();
  if (!pm) {
    return { ok: false, error: "no package manager found on PATH (need npm, pnpm, yarn, or bun)" };
  }

  try {
    await execFileAsync(pm.command, pm.installArgs, {
      cwd: params.packageDir,
      timeout: INSTALL_TIMEOUT_MS,
      env: { ...process.env, ...INSTALL_ENV },
    });
  } catch (err: unknown) {
    const detail =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr: unknown }).stderr).trim()
        : String(err);
    return { ok: false, error: `${pm.command} install failed: ${detail || String(err)}` };
  }

  return { ok: true };
}
