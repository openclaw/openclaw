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
// - `npm_config_audit=false` / `npm_config_fund=false` for deterministic,
//   reduced-noise installs during update flows.
//
// Security-defensive discovery:
// - Rejects symlinked entries under `dist/extensions` and enforces realpath
//   containment so a tampered `dist/extensions/<x>` cannot redirect the
//   install subprocess to write outside the install root.
// - Size-guards `package.json` reads (1MB cap) before parsing so a corrupt
//   or oversized file can't stall the sync scan.
// - Considers a plugin "staged" only when every declared runtime dependency
//   (including `optionalDependencies` per the sibling `collectRuntimeDeps`
//   pattern) has a sentinel `package.json` under `node_modules/`. A bare
//   `node_modules/` directory left over from a failed install attempt is
//   not treated as healthy.

import fs from "node:fs";
import path from "node:path";

export type StagingPackageManager = "pnpm" | "npm" | "bun";

const PACKAGE_JSON_SIZE_LIMIT_BYTES = 1024 * 1024;

export type CheckedExtension = {
  id: string;
  hasStagedDeps: boolean;
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

  const extensionsRealPath = tryRealpath(extensionsDir);
  if (!extensionsRealPath) {
    // Extensions dir itself isn't a real directory we can resolve — treat as
    // empty rather than scan through a potentially redirected tree.
    return { checked, missing };
  }

  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) {
      continue;
    }
    const extDir = path.join(extensionsDir, entry.name);
    if (!isContainedRealPath(extDir, extensionsRealPath)) {
      // Symlinked or otherwise redirected entry — refuse to consider it.
      continue;
    }

    const packageJsonPath = path.join(extDir, "package.json");
    const pkg = tryReadPackageJson(packageJsonPath);
    if (!pkg) {
      continue;
    }

    if (!isStageRuntimeDependenciesTrue(pkg)) {
      continue;
    }

    const depNames = collectRuntimeDepNames(pkg);
    const hasStagedDeps = hasAllDeclaredDepSentinels(extDir, depNames);

    checked.push({ id: entry.name, hasStagedDeps, dependencyCount: depNames.length });

    if (!hasStagedDeps && depNames.length > 0) {
      missing.push({
        id: entry.name,
        expectedPath: path.join(extDir, "node_modules"),
        dependencyCount: depNames.length,
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
    const stat = fs.lstatSync(packageJsonPath);
    // Reject symlinked package.json too — matches the directory-entry policy.
    if (stat.isSymbolicLink()) {
      return null;
    }
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

// Match the sibling pattern in `scripts/postinstall-bundled-plugins.mjs` →
// `collectRuntimeDeps`: declared runtime deps include `optionalDependencies`.
// A plugin that moves any dep into `optionalDependencies` still expects it
// present at stage time for the `stageRuntimeDependencies: true` contract.
function collectRuntimeDepNames(pkg: unknown): string[] {
  const p = pkg as {
    dependencies?: Record<string, unknown>;
    optionalDependencies?: Record<string, unknown>;
  } | null;
  const names = new Set<string>();
  if (p?.dependencies && typeof p.dependencies === "object") {
    for (const name of Object.keys(p.dependencies)) {
      names.add(name);
    }
  }
  if (p?.optionalDependencies && typeof p.optionalDependencies === "object") {
    for (const name of Object.keys(p.optionalDependencies)) {
      names.add(name);
    }
  }
  return [...names];
}

// A plugin is considered staged only when every declared runtime dep has its
// sentinel `package.json` present. `existsSync` on just `node_modules/` is
// not enough — a partial install (network failure mid-way, interrupted
// repair) can leave behind an incomplete directory that would otherwise
// suppress retry on the next update.
function hasAllDeclaredDepSentinels(extDir: string, depNames: string[]): boolean {
  if (depNames.length === 0) {
    return true;
  }
  return depNames.every((depName) => {
    const segments = depName.split("/");
    const sentinelPath = path.join(extDir, "node_modules", ...segments, "package.json");
    return fs.existsSync(sentinelPath);
  });
}

function tryRealpath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function isContainedRealPath(candidate: string, parentRealPath: string): boolean {
  try {
    const lstat = fs.lstatSync(candidate);
    if (lstat.isSymbolicLink()) {
      return false;
    }
  } catch {
    return false;
  }
  const candidateReal = tryRealpath(candidate);
  if (!candidateReal) {
    return false;
  }
  // Same-path is allowed (the parent itself can be a valid candidate target
  // for outer checks), but for per-entry containment we require strict
  // prefix — the extension dir must be inside the extensions root.
  const withSep = parentRealPath.endsWith(path.sep) ? parentRealPath : parentRealPath + path.sep;
  return candidateReal.startsWith(withSep);
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
export type SkippedRepairEntry = {
  id: string;
  reason: string;
};

export type RepairResult = {
  repaired: RepairedEntry[];
  failed: FailedRepairEntry[];
  skipped: SkippedRepairEntry[];
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
  // early-exit guard and the repair call. Each entry's path is still
  // validated to live inside `extensionsDir` before any subprocess spawn.
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
  const skipped: SkippedRepairEntry[] = [];

  const command = packageManagerCommand ?? packageManager;
  const installArgs = resolveProductionInstallArgs(packageManager);
  const env = createBundledPluginStagingInstallEnv(params.baseEnv);

  // Re-validate containment per entry even when the caller provides `missing`:
  // defense against a tampered input list feeding a path outside the install
  // root into the subprocess `cwd`.
  const extensionsRealPath = tryRealpath(extensionsDir);

  for (const entry of missing) {
    const extDir = path.dirname(entry.expectedPath);
    if (!extensionsRealPath || !isContainedRealPath(extDir, extensionsRealPath)) {
      skipped.push({
        id: entry.id,
        reason: "extension directory is not contained within extensionsDir (symlink or redirect?)",
      });
      continue;
    }
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

  return { repaired, failed, skipped };
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
// write, no package.json save. `npm_config_*` keys are honored by pnpm and
// bun (npm-config-compatible) so a single env works across managers.
//
// The stripped keys are set to `undefined` rather than deleted because
// `runCommandWithTimeout`'s `resolveCommandEnv` merges `process.env` under
// the caller-provided env (`{ ...baseEnv, ...params.env }`). A plain
// `delete` on the returned object would be silently restored by the merge;
// setting the key to `undefined` overwrites the inherited value, and the
// merge's undefined-filter then strips it from the final subprocess env.
export function createBundledPluginStagingInstallEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...env,
    // Strip nested-install context, both casing variants (Windows convention).
    npm_config_global: undefined,
    npm_config_location: undefined,
    npm_config_prefix: undefined,
    NPM_CONFIG_GLOBAL: undefined,
    NPM_CONFIG_LOCATION: undefined,
    NPM_CONFIG_PREFIX: undefined,
    // Deterministic install overlays.
    npm_config_legacy_peer_deps: "true",
    npm_config_package_lock: "false",
    npm_config_save: "false",
    // Defense-in-depth during update-driven installs.
    npm_config_audit: "false",
    npm_config_fund: "false",
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
// - All-success (every discovered plugin repaired) → step exit 0, clean
//   stdoutTail, null stderrTail.
// - Partial-success (at least one repaired, one or more failed or skipped)
//   → step exit 0 with failures surfaced in the stdoutTail. The step
//   renderer (`src/cli/update-cli/progress.ts`) prints stderrTail only when
//   exit code is non-zero, so embedding the failure summary in stdoutTail
//   keeps TTY output honest on partial outcomes.
// - Total-failure (work attempted, zero repaired) → step exit 1; full
//   detail goes to stderrTail where the renderer shows it.
export function summarizeRepairForUpdateStep(params: {
  attempted: number;
  repair: RepairResult;
}): UpdateStepClassification {
  const { attempted, repair } = params;
  const succeeded = repair.repaired.length;
  const problematic = repair.failed.length + repair.skipped.length;
  const totalFailure = attempted > 0 && succeeded === 0;
  const stepExitCode: 0 | 1 = totalFailure ? 1 : 0;

  const repairedList = repair.repaired.map((entry) => entry.id).join(", ") || "(none)";
  const problemLines = [
    ...repair.failed.map((entry) => `${entry.id}: ${entry.detail}`),
    ...repair.skipped.map((entry) => `${entry.id}: skipped (${entry.reason})`),
  ];

  const baseLine = `staged ${succeeded} of ${attempted}: ${repairedList}`;
  let stdoutTail = baseLine;
  let stderrTail: string | null = null;

  if (problematic > 0) {
    if (totalFailure) {
      // Renderer shows stderrTail on non-zero exit — full detail goes there.
      stderrTail = problemLines.join("\n");
    } else {
      // Renderer hides stderrTail on zero exit, so the partial-failure
      // summary must go into stdoutTail to stay visible. The `!` sigil keeps
      // it scannable in progress output and in the final step record.
      stdoutTail = [
        baseLine,
        `! ${problematic} plugin(s) not staged — run \`openclaw doctor\` to retry:`,
        ...problemLines.map((line) => `  - ${line}`),
      ].join("\n");
    }
  }

  return { stepExitCode, stdoutTail, stderrTail };
}
