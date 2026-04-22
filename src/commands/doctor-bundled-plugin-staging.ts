// Detect and repair bundled-plugin runtime-dep staging gaps.
//
// Bundled plugins that declare `openclaw.bundle.stageRuntimeDependencies: true`
// in their own `package.json` are expected to have a sibling `node_modules/`
// directory at install time. On `package`-kind installs (pnpm/npm global),
// the publish tarball strips these directories via `!dist/extensions/*/node_modules/**`
// in the core `files` manifest, so the staging must be re-created on the
// client. `scripts/postinstall-bundled-plugins.mjs` intentionally does not
// eagerly install per-plugin runtime deps; its top comment notes that
// `openclaw doctor --fix` owns the repair path for extensions that are
// actually used. This module is that repair path, invoked today by
// `openclaw update` right after the global install step.
//
// Design mirrors `scripts/postinstall-bundled-plugins.mjs`:
// - `--ignore-scripts` on every install to prevent dep lifecycle scripts
//   from running client-side.
// - `npm_config_package_lock=false` / `npm_config_save=false` to keep the
//   extension directories read-only from the install's perspective (no new
//   lockfiles, no mutations to `package.json`).
// - `npm_config_legacy_peer_deps=true` for consistent peer-dep tolerance.

import fs from "node:fs";
import path from "node:path";

export type StagingPackageManager = "pnpm" | "npm" | "bun";

const PACKAGE_JSON_SIZE_LIMIT_BYTES = 1024 * 1024;

export type CheckedExtension = {
  id: string;
  hasNodeModules: boolean;
  dependencyCount: number;
};

export type MissingStagingEntry = {
  id: string;
  expectedPath: string;
  dependencyCount: number;
};

export type DiscoveryResult = {
  checked: CheckedExtension[];
  missing: MissingStagingEntry[];
};

export type DiscoveryParams = {
  extensionsDir: string;
};

export function discoverMissingBundledPluginStaging(params: DiscoveryParams): DiscoveryResult {
  const { extensionsDir } = params;
  const checked: CheckedExtension[] = [];
  const missing: MissingStagingEntry[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(extensionsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { checked, missing };
    }
    throw error;
  }

  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) {
      continue;
    }
    const extDir = path.join(extensionsDir, entry.name);
    const packageJsonPath = path.join(extDir, "package.json");

    const pkg = tryReadPackageJson(packageJsonPath);
    if (!pkg) {
      continue;
    }

    if (!isStageRuntimeDependenciesTrue(pkg)) {
      continue;
    }

    const dependencyCount = countRuntimeDependencies(pkg);
    const hasNodeModules = fs.existsSync(path.join(extDir, "node_modules"));

    checked.push({ id: entry.name, hasNodeModules, dependencyCount });

    if (!hasNodeModules && dependencyCount > 0) {
      missing.push({
        id: entry.name,
        expectedPath: path.join(extDir, "node_modules"),
        dependencyCount,
      });
    }
  }

  return { checked, missing };
}

function tryReadPackageJson(packageJsonPath: string): unknown {
  // Size-guard before reading: a malicious or corrupt file in the extensions
  // directory should not block the update/doctor flow on a huge synchronous
  // read or parse. Valid bundled-plugin package.json files are a few KB.
  try {
    const stat = fs.statSync(packageJsonPath);
    if (stat.size > PACKAGE_JSON_SIZE_LIMIT_BYTES) {
      return null;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  } catch {
    // Malformed JSON: skip here; other doctor checks report it.
    return null;
  }
}

function isStageRuntimeDependenciesTrue(pkg: unknown): boolean {
  const bundle = (pkg as { openclaw?: { bundle?: { stageRuntimeDependencies?: unknown } } })
    ?.openclaw?.bundle;
  return bundle?.stageRuntimeDependencies === true;
}

function countRuntimeDependencies(pkg: unknown): number {
  const deps = (pkg as { dependencies?: Record<string, unknown> })?.dependencies;
  if (deps && typeof deps === "object") {
    return Object.keys(deps).length;
  }
  return 0;
}

export type RunCommandResult = { exitCode: number; stdout: string; stderr: string };

export type RunCommandFn = (params: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}) => Promise<RunCommandResult>;

export type RepairedEntry = { id: string };
export type FailedRepairEntry = {
  id: string;
  exitCode: number;
  detail: string;
};

export type RepairResult = {
  repaired: RepairedEntry[];
  failed: FailedRepairEntry[];
};

export type RepairParams = {
  extensionsDir: string;
  packageManager: StagingPackageManager;
  // Resolved executable path for the package manager. When provided, spawn
  // targets this path instead of resolving `packageManager` through `PATH`.
  // Match the caller's trusted command resolution (e.g. an install-root-local
  // npm) instead of relying on ambient `PATH` lookup.
  packageManagerCommand?: string;
  // Pre-computed list of plugins to repair. When provided, skips the inner
  // discovery scan so the caller can run a single discovery for both the
  // early-exit guard and the repair call.
  missing?: MissingStagingEntry[];
  // Base environment for the install subprocess, before the staging-specific
  // `npm_config_*` overlays are applied. Callers should pass the same
  // hardened env they use for the main install step (e.g. the output of
  // `createGlobalInstallEnv`) so `PATH` and corepack-prompt settings stay
  // deterministic across both steps. Defaults to `process.env` when omitted.
  baseEnv?: NodeJS.ProcessEnv;
  runCommand: RunCommandFn;
};

export async function repairBundledPluginStaging(params: RepairParams): Promise<RepairResult> {
  const { extensionsDir, packageManager, packageManagerCommand, runCommand } = params;
  const missing = params.missing ?? discoverMissingBundledPluginStaging({ extensionsDir }).missing;

  const repaired: RepairedEntry[] = [];
  const failed: FailedRepairEntry[] = [];

  const command = packageManagerCommand ?? packageManager;
  const installArgs = resolveProductionInstallArgs(packageManager);
  const env = createBundledPluginStagingInstallEnv(params.baseEnv);

  for (const entry of missing) {
    const extDir = path.dirname(entry.expectedPath);
    const result = await runCommand({
      command,
      args: installArgs,
      cwd: extDir,
      env,
    });
    if (result.exitCode === 0) {
      repaired.push({ id: entry.id });
    } else {
      failed.push({
        id: entry.id,
        exitCode: result.exitCode,
        detail: summarizeCommandFailure(result),
      });
    }
  }

  return { repaired, failed };
}

const PRODUCTION_INSTALL_ARGS: Record<StagingPackageManager, readonly string[]> = {
  pnpm: ["install", "--prod", "--ignore-scripts"],
  npm: ["install", "--omit=dev", "--ignore-scripts"],
  bun: ["install", "--production", "--ignore-scripts"],
};

function resolveProductionInstallArgs(packageManager: StagingPackageManager): string[] {
  return [...PRODUCTION_INSTALL_ARGS[packageManager]];
}

// Mirrors `scripts/postinstall-bundled-plugins.mjs` →
// `createBundledRuntimeDependencyInstallEnv`: peer-dep tolerance, no lockfile
// write, no package.json save. Strips nested-install env leakage (matches
// `createNestedNpmInstallEnv`). `npm_config_*` keys are honored by pnpm and
// bun (npm-config-compatible) so a single env works across managers.
export function createBundledPluginStagingInstallEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  delete next.npm_config_global;
  delete next.npm_config_location;
  delete next.npm_config_prefix;
  return {
    ...next,
    npm_config_legacy_peer_deps: "true",
    npm_config_package_lock: "false",
    npm_config_save: "false",
  };
}

function summarizeCommandFailure(result: RunCommandResult): string {
  const combined = [result.stderr, result.stdout]
    .map((chunk) => chunk?.trim?.() ?? "")
    .filter((chunk) => chunk.length > 0)
    .join(" | ");
  return combined.length > 0 ? combined : `exit ${result.exitCode}`;
}

export type UpdateStepClassification = {
  stepExitCode: 0 | 1;
  stdoutTail: string;
  stderrTail: string | null;
};

// Classify a repair run for the update step's result record.
// Semantics:
// - All-success (every discovered plugin repaired) → step exit 0.
// - Partial-success (at least one repaired, one or more failed) → step exit 0
//   with failed plugins surfaced via stderrTail. The update binary is
//   successfully installed; failed plugins are no worse off than pre-update
//   and do not justify flipping the whole update to `status: "error"`, which
//   would mislead automated callers into retrying the package install.
// - Total-failure (work attempted, zero repaired, all failed) → step exit 1.
export function summarizeRepairForUpdateStep(params: {
  attempted: number;
  repair: RepairResult;
}): UpdateStepClassification {
  const { attempted, repair } = params;
  const succeeded = repair.repaired.length;
  const totalFailure = attempted > 0 && succeeded === 0;
  const stepExitCode: 0 | 1 = totalFailure ? 1 : 0;

  const repairedList = repair.repaired.map((entry) => entry.id).join(", ") || "(none)";
  const stdoutTail = `staged ${succeeded} of ${attempted}: ${repairedList}`;
  const stderrTail =
    repair.failed.length > 0
      ? repair.failed.map((entry) => `${entry.id}: ${entry.detail}`).join("\n")
      : null;

  return { stepExitCode, stdoutTail, stderrTail };
}
