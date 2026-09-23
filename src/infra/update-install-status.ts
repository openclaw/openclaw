import { resolveOpenClawPackageRoot } from "./openclaw-root.js";
import { readVerifiedGitUpdateReceipt } from "./restart-sentinel.js";
import { checkUpdateStatus } from "./update-check.js";
import { updateInstallRootsMatch } from "./update-install-root.js";

export async function resolveStartupInstallStatus(fetchRemoteGit: boolean, signal: AbortSignal) {
  const [root, installReceipt] = await Promise.all([
    resolveOpenClawPackageRoot({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    }),
    readVerifiedGitUpdateReceipt(),
  ]);
  const gitUpstreamFallback =
    installReceipt?.upstreamRef && root && updateInstallRootsMatch(root, installReceipt.root)
      ? { currentSha: installReceipt.sha, upstreamRef: installReceipt.upstreamRef }
      : undefined;
  const status = await checkUpdateStatus({
    root,
    signal,
    ...(fetchRemoteGit ? {} : { timeoutMs: 2500 }),
    fetchGit: fetchRemoteGit,
    includeRegistry: false,
    ...(fetchRemoteGit ? { useDetachedDevUpstream: true } : {}),
    ...(gitUpstreamFallback ? { gitUpstreamFallback } : {}),
  });
  signal.throwIfAborted();
  return { root, status, installReceipt };
}
