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
// actually used. This module implements that repair path.

import fs from "node:fs";
import path from "node:path";

export type StagingPackageManager = "pnpm" | "npm" | "bun" | "yarn";

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

    let pkg: unknown;
    try {
      const raw = fs.readFileSync(packageJsonPath, "utf8");
      pkg = JSON.parse(raw);
    } catch {
      // Missing or malformed package.json: surface via other doctor checks,
      // not this one.
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
  runCommand: RunCommandFn;
};

export async function repairBundledPluginStaging(params: RepairParams): Promise<RepairResult> {
  const { extensionsDir, packageManager, runCommand } = params;
  const { missing } = discoverMissingBundledPluginStaging({ extensionsDir });

  const repaired: RepairedEntry[] = [];
  const failed: FailedRepairEntry[] = [];

  for (const entry of missing) {
    const extDir = path.dirname(entry.expectedPath);
    const installArgs = resolveProductionInstallArgs(packageManager);
    const result = await runCommand({
      command: packageManager,
      args: installArgs,
      cwd: extDir,
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
  pnpm: ["install", "--prod"],
  npm: ["install", "--omit=dev"],
  yarn: ["install", "--production"],
  bun: ["install", "--production"],
};

function resolveProductionInstallArgs(packageManager: StagingPackageManager): string[] {
  return [...PRODUCTION_INSTALL_ARGS[packageManager]];
}

function summarizeCommandFailure(result: RunCommandResult): string {
  const combined = [result.stderr, result.stdout]
    .map((chunk) => chunk?.trim?.() ?? "")
    .filter((chunk) => chunk.length > 0)
    .join(" | ");
  return combined.length > 0 ? combined : `exit ${result.exitCode}`;
}
