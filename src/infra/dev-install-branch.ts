// Resolves the git branch of a source-checkout (non-release) install so
// surfaces like the Control UI footer can flag dev gateways. Release installs
// (npm/package) and mainline checkouts resolve to null.
import fs from "node:fs/promises";
import path from "node:path";
import { runCommandWithTimeout } from "../process/exec.js";
import { resolveOpenClawPackageRoot } from "./openclaw-root.js";

const GIT_TIMEOUT_MS = 3000;
// Mainline branches read as release-shaped state; the badge exists to flag
// checkouts that drifted off the mainline. "HEAD" is git's detached marker.
const HIDDEN_BRANCHES = new Set(["main", "master", "HEAD"]);

async function detectDevInstallGitBranch(packageRoot: string | null): Promise<string | null> {
  const root = packageRoot ? path.resolve(packageRoot) : null;
  if (!root) {
    return null;
  }
  const topRes = await runCommandWithTimeout(["git", "-C", root, "rev-parse", "--show-toplevel"], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (topRes.code !== 0) {
    return null;
  }
  // Same rule as update-check's installKind: only a package root that is
  // itself a git toplevel counts as a source checkout. A package install
  // nested inside an unrelated repo must not surface that repo's branch.
  const rootReal = await fs.realpath(root).catch(() => root);
  const top = topRes.stdout.trim();
  if (!top || path.resolve(top) !== path.resolve(rootReal)) {
    return null;
  }
  const branchRes = await runCommandWithTimeout(
    ["git", "-C", root, "rev-parse", "--abbrev-ref", "HEAD"],
    {
      timeoutMs: GIT_TIMEOUT_MS,
    },
  );
  if (branchRes.code !== 0) {
    return null;
  }
  const branch = branchRes.stdout.trim();
  return branch && !HIDDEN_BRANCHES.has(branch) ? branch : null;
}

// Install metadata is process-stable (checkout switches require a restart),
// so a single-slot promise cache keeps git out of the request hot path.
let cached: Promise<string | null> | null = null;

export function resolveDevInstallGitBranch(): Promise<string | null> {
  cached ??= resolveOpenClawPackageRoot({
    argv1: process.argv[1],
    cwd: process.cwd(),
    moduleUrl: import.meta.url,
  })
    .then(detectDevInstallGitBranch)
    .catch(() => null);
  return cached;
}
