import fs from "node:fs";
import path from "node:path";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import {
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
} from "../daemon/constants.js";
import { resolveGitHeadPath } from "./git-root.js";
import { resolveOpenClawPackageRootSync } from "./openclaw-root.js";

export type RuntimeFingerprint = {
  branch: string;
  worktree: string;
  stateDir: string;
  configPath: string;
  serviceLabel: string;
};

export function resolveRuntimeFingerprint(
  params: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    moduleUrl?: string;
    platform?: NodeJS.Platform;
    serviceLabel?: string;
  } = {},
): RuntimeFingerprint {
  const env = params.env ?? process.env;
  const cwd = path.resolve(params.cwd ?? process.cwd());
  // Anchor identity to the package root when we are inside a git worktree so
  // status/startup output stays stable even if a subcommand runs from `src/`.
  const worktree =
    resolveOpenClawPackageRootSync({
      cwd,
      moduleUrl: params.moduleUrl,
    }) ?? cwd;
  const stateDir = resolveStateDir(env);
  const configPath = resolveConfigPath(env, stateDir);

  return {
    branch: resolveBranchName(worktree),
    worktree,
    stateDir,
    configPath,
    serviceLabel: params.serviceLabel ?? resolveGatewayServiceLabel(env, params.platform),
  };
}

export function formatRuntimeFingerprint(
  fingerprint: RuntimeFingerprint,
  formatPath: (value: string) => string = (value) => value,
): string {
  return [
    `branch=${fingerprint.branch}`,
    `worktree=${formatPath(fingerprint.worktree)}`,
    `stateDir=${formatPath(fingerprint.stateDir)}`,
    `configPath=${formatPath(fingerprint.configPath)}`,
    `serviceLabel=${fingerprint.serviceLabel}`,
  ].join(" ");
}

function resolveBranchName(searchDir: string): string {
  const headPath = resolveGitHeadPath(searchDir);
  if (!headPath) {
    return "unknown";
  }

  try {
    const head = fs.readFileSync(headPath, "utf-8").trim();
    if (!head) {
      return "unknown";
    }
    // Detached checkouts still matter for diagnostics; keep the explicit HEAD
    // marker instead of inventing a branch name from a commit hash.
    if (!head.startsWith("ref:")) {
      return "HEAD";
    }

    const ref = head.replace(/^ref:\s*/i, "").trim();
    const headBranch = ref.match(/^refs\/heads\/(.+)$/)?.[1]?.trim();
    return headBranch || "HEAD";
  } catch {
    return "unknown";
  }
}

function resolveGatewayServiceLabel(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  const profile = env.OPENCLAW_PROFILE;
  if (platform === "darwin") {
    return resolveGatewayLaunchAgentLabel(profile);
  }
  if (platform === "win32") {
    return resolveGatewayWindowsTaskName(profile);
  }
  return `${resolveGatewaySystemdServiceName(profile)}.service`;
}
