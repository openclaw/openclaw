import fs from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { hasErrnoCode } from "./errno.js";
import { resolvePnpmCandidateEnv } from "./update-package-manager.js";
import { isFailedUpdateStep } from "./update-run-step.js";
import { runStep } from "./update-runner-command.js";
import type { CommandRunner, RunStepOptions } from "./update-runner-types.js";
import type { UpdateStepResult } from "./update-step-result.js";

const BUILD_MAX_OLD_SPACE_MB = 8192;
const DEV_PREFLIGHT_LINT_ENV: NodeJS.ProcessEnv = {
  OPENCLAW_LOCAL_CHECK: "1",
  OPENCLAW_LOCAL_CHECK_MODE: "throttled",
};
const DEV_PREFLIGHT_LINT_OPT_IN_ENV = "OPENCLAW_UPDATE_PREFLIGHT_LINT";

const PREFLIGHT_TEMP_PREFIX =
  process.platform === "win32" ? "ocu-pf-" : ".openclaw-update-preflight-";
const WINDOWS_PREFLIGHT_BASE_DIR = "ocu";

export type StepFactory = (
  name: string,
  argv: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
) => RunStepOptions;

export function resolveTagFetchRef(candidate: string): string | null {
  const ref = candidate.endsWith("^{}") ? candidate.slice(0, -"^{}".length) : candidate;
  return ref.startsWith("refs/tags/") ? ref : null;
}

export function buildDevTargetRefResolutionCandidates(devTargetRef: string): string[] {
  const trimmed = devTargetRef.trim();
  if (/^[0-9a-f]{40}$/i.test(trimmed) || trimmed.startsWith("refs/remotes/")) {
    return [trimmed];
  }
  if (trimmed.startsWith("refs/heads/")) {
    return [`refs/remotes/origin/${trimmed.slice("refs/heads/".length)}`];
  }
  if (trimmed.startsWith("origin/")) {
    return [`refs/remotes/${trimmed}`];
  }
  if (trimmed.startsWith("refs/tags/")) {
    return [`${trimmed}^{}`, trimmed];
  }
  // Plain branch names resolve from the freshly fetched remote ref.
  return [`refs/remotes/origin/${trimmed}`, `refs/tags/${trimmed}^{}`, `refs/tags/${trimmed}`];
}

export async function createPreflightRoot(artifactRoot: string) {
  // On POSIX, ignored artifact storage keeps interrupted worktrees out of Git status.
  // Honor existing redirects like build-all-cache; only the mkdtemp child is private.
  const baseDir =
    process.platform === "win32" && path.sep === "\\"
      ? path.win32.join(process.env.SystemDrive ?? "C:", WINDOWS_PREFLIGHT_BASE_DIR)
      : path.join(await fs.realpath(artifactRoot), ".artifacts");
  await fs.mkdir(baseDir, { recursive: true });
  return fs.mkdtemp(path.join(baseDir, PREFLIGHT_TEMP_PREFIX));
}

export async function resetPreflightCandidateWorktree(worktreeDir: string, step: StepFactory) {
  const resetStep = await runStep(
    step("preflight-reset", ["git", "-C", worktreeDir, "reset", "--hard"], worktreeDir),
  );
  if (isFailedUpdateStep(resetStep)) {
    return false;
  }
  const cleanStep = await runStep(
    step("preflight-clean", ["git", "-C", worktreeDir, "clean", "-fdx"], worktreeDir),
  );
  return !isFailedUpdateStep(cleanStep);
}

export function classifyPreflightFailure(step: UpdateStepResult): "failed" | "insufficient-space" {
  // pnpm reports filesystem errors on stdout by default. Require the storage
  // diagnostic: ENOSPC also covers inotify limits.
  const output = stripAnsi(`${step.stdoutTail ?? ""}\n${step.stderrTail ?? ""}`);
  const nodeNoSpace =
    /^\s*(?:\[(?:ERR_PNPM_)?ENOSPC\][^\r\n]*|(?:Error:\s*)?)ENOSPC: no space left on device(?:,|$)/m.test(
      output,
    );
  // Git uses strerror without an errno token; require a complete operation diagnostic.
  const gitNoSpace =
    /^(?:fatal|error): (?:cannot|could not|unable to) [^\r\n]+: No space left on device$/m.test(
      output,
    );
  return nodeNoSpace || gitNoSpace ? "insufficient-space" : "failed";
}

export function shouldInstallWithoutScriptsOnWindows(manager: "pnpm" | "bun" | "npm"): boolean {
  return process.platform === "win32" && manager === "pnpm";
}

function resolveBuildNodeOptions(baseOptions: string | undefined): string {
  const current = baseOptions?.trim() ?? "";
  const desired = `--max-old-space-size=${BUILD_MAX_OLD_SPACE_MB}`;
  const existingMatch = /(?:^|\s)--max-old-space-size=(\d+)(?=\s|$)/.exec(current);
  if (!existingMatch) {
    return current ? `${current} ${desired}` : desired;
  }
  const existingValue = Number(existingMatch[1]);
  if (Number.isFinite(existingValue) && existingValue >= BUILD_MAX_OLD_SPACE_MB) {
    return current;
  }
  return current.replace(/(?:^|\s)--max-old-space-size=\d+(?=\s|$)/, ` ${desired}`).trim();
}

export function resolveBuildEnv(
  env: NodeJS.ProcessEnv = process.env,
  buildCacheRoot?: string,
): NodeJS.ProcessEnv {
  return {
    ...env,
    OPENCLAW_UPDATE_IN_PROGRESS: "1",
    NODE_OPTIONS: resolveBuildNodeOptions(env.NODE_OPTIONS ?? process.env.NODE_OPTIONS),
    ...(buildCacheRoot ? { BUILD_ALL_CACHE_ROOT: buildCacheRoot } : {}),
  };
}

export function gitCleanCheckArgs(
  gitRoot: string,
  sourceTreeStagingPaths: readonly string[] = [],
): string[] {
  return [
    "git",
    "-C",
    gitRoot,
    "status",
    "--porcelain",
    "--",
    ":!dist/control-ui/",
    ...sourceTreeStagingPaths.map((relative) => `:(top,exclude,literal)${relative}`),
  ];
}

async function hasExplicitPnpmPreferOfflineConfig(params: {
  runCommand: CommandRunner;
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}): Promise<boolean> {
  try {
    const result = await params.runCommand(["pnpm", "config", "get", "prefer-offline"], {
      cwd: params.cwd,
      timeoutMs: params.timeoutMs,
      env: params.env,
    });
    if (result.code !== 0) {
      return true;
    }
    // pnpm reports only explicitly configured typed values; these sentinels mean absent.
    const value = result.stdout.trim();
    return value !== "" && value !== "undefined" && value !== "null";
  } catch {
    // A failed provenance check must not override an operator's possible explicit policy.
    return true;
  }
}

export async function prepareCandidateCommandEnv(
  manager: "pnpm" | "bun" | "npm",
  env: NodeJS.ProcessEnv | undefined,
  cwd: string,
  runCommand: CommandRunner,
  timeoutMs: number,
): Promise<{ env: NodeJS.ProcessEnv; restoreWorkspace?: () => Promise<void> }> {
  // Source launchers select the serving checkout; candidate builds must not
  // resolve their plugin SDK or bundled sources through that inherited root.
  const effectiveEnv: NodeJS.ProcessEnv = {
    ...(env ?? process.env),
    OPENCLAW_DEV_SOURCE_ROOT: cwd,
  };
  if (manager !== "pnpm") {
    return { env: effectiveEnv };
  }
  const hasExplicitPreferOffline =
    effectiveEnv.pnpm_config_prefer_offline !== undefined ||
    effectiveEnv.PNPM_CONFIG_PREFER_OFFLINE !== undefined ||
    (await hasExplicitPnpmPreferOfflineConfig({ runCommand, cwd, timeoutMs, env: effectiveEnv }));
  const candidateEnv: NodeJS.ProcessEnv = {
    ...resolvePnpmCandidateEnv(effectiveEnv, "node_modules/.pnpm"),
    PNPM_CONFIG_RESOLUTION_MODE: env?.PNPM_CONFIG_RESOLUTION_MODE ?? "highest",
    npm_config_resolution_mode: env?.npm_config_resolution_mode ?? "highest",
    pnpm_config_resolution_mode: env?.pnpm_config_resolution_mode ?? "highest",
  };
  if (!hasExplicitPreferOffline) {
    candidateEnv.PNPM_CONFIG_PREFER_OFFLINE = "true";
    candidateEnv.pnpm_config_prefer_offline = "true";
  }
  const workspaceFile = path.join(cwd, "pnpm-workspace.yaml");
  const original = await fs.readFile(workspaceFile, "utf8").catch((error: unknown) => {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  });
  if (original === undefined) {
    return { env: candidateEnv };
  }
  // pnpm 10 applies workspace settings after env, including in nested installs.
  // Only the disposable worktree gets this override; retain all operator settings.
  const workspace = parseDocument(original);
  workspace.set("virtualStoreDir", "node_modules/.pnpm");
  const isolated = workspace.toString();
  const backupDirectory = await fs.mkdtemp(path.join(path.dirname(cwd), "workspace-original-"));
  const backupFile = path.join(backupDirectory, "pnpm-workspace.yaml");
  // Move the entry so a tracked symlink never lets preparation edit its external target.
  await fs.rename(workspaceFile, backupFile);
  await fs.writeFile(workspaceFile, isolated);
  return {
    env: candidateEnv,
    restoreWorkspace: async () => {
      // Do not hide build/lifecycle edits from the authoritative Git clean check.
      if (
        (await fs.lstat(workspaceFile)).isFile() &&
        (await fs.readFile(workspaceFile, "utf8")) === isolated
      ) {
        await fs.rename(backupFile, workspaceFile);
      }
      await fs.rm(backupDirectory, { recursive: true, force: true });
    },
  };
}

export function shouldRunDevPreflightLint(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[DEV_PREFLIGHT_LINT_OPT_IN_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

export function resolveDevPreflightLintEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return { ...env, ...DEV_PREFLIGHT_LINT_ENV };
}
