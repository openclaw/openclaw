import fs from "node:fs/promises";
import path from "node:path";
import { DEV_BRANCH } from "./update-channels.js";
import type { UpdateRunRecord } from "./update-run-record.js";

export type StaleUpdateFetch = {
  reason: "fetch-failed";
  failedAtMs: number;
  detail: string;
  runId: string;
};

// Match Git's transport_anonymize_url/display_state_init representation without
// URL parsing, which would change case, encoding, and relative fetch paths.
function describeFetchSource(raw: string): { url: string; relative: boolean } {
  const colon = raw.indexOf(":");
  const slash = raw.indexOf("/");
  const local =
    colon < 0 ||
    (slash >= 0 && slash < colon) ||
    (process.platform === "win32" && /^[a-z]:/iu.test(raw));
  let url = raw;
  const at = raw.indexOf("@");
  if (!local && at >= 0) {
    const scheme = raw.indexOf("://");
    if (scheme < 0 && raw.slice(at + 1).includes(":")) {
      url = raw.slice(at + 1);
    } else if (scheme >= 0 && /^[a-z0-9+.-]*$/iu.test(raw.slice(0, scheme))) {
      const pathStart = raw.indexOf("/", scheme + 3);
      if (pathStart < 0 || pathStart > at) {
        url = raw.slice(0, scheme + 3) + raw.slice(at + 1);
      }
    }
  }
  url = url.replace(/\/+$/u, "");
  if (url.length > 5 && url.endsWith(".git")) {
    url = url.slice(0, -4);
  }
  return { url: url.replace(/\n/gu, "\\n"), relative: local && !path.isAbsolute(raw) };
}

export async function resolveStaleUpdateFetch(params: {
  root: string;
  run?: UpdateRunRecord;
  branch: string | null;
  upstreamRevision: string;
  upstreamCommit: string | null;
  readGit: (...args: string[]) => Promise<string | null>;
}): Promise<StaleUpdateFetch | undefined> {
  const run = params.run;
  if (!run || run.status !== "failed" || run.target.kind === "package") {
    return undefined;
  }
  const failedStep = run.steps.findLast(
    (step) =>
      step.status === "failed" &&
      (/^git (?:fetch(?:\s|$)|target inspection fetch$)/u.test(step.step) ||
        step.step === "git import admitted target"),
  );
  if (run.reason !== "fetch-failed" && !failedStep) {
    return undefined;
  }
  const failedAtMs = failedStep?.endedAtMs ?? run.finishedAtMs ?? run.updatedAtMs;
  // Failed fetches can write FETCH_HEAD. Recovery needs a later record matching
  // the tracked source; loose/packed ref mtimes alone cannot establish that.
  const ref = params.upstreamCommit
    ? await params.readGit(
        "rev-parse",
        "--symbolic-full-name",
        params.upstreamRevision.replace(/\^\{commit\}$/u, ""),
      )
    : null;
  if (ref?.startsWith("refs/remotes/")) {
    // Tracking refs are shared, but a no-change fetch only touches the fetching
    // worktree's FETCH_HEAD. Include the primary and linked worktrees' evidence.
    const commonDir = await params.readGit("rev-parse", "--git-common-dir");
    const gitDir = commonDir ? path.resolve(params.root, commonDir) : null;
    const worktrees = gitDir
      ? await fs.readdir(path.join(gitDir, "worktrees"), { withFileTypes: true }).catch(() => [])
      : [];
    const fetchPaths = gitDir
      ? [
          path.join(gitDir, "FETCH_HEAD"),
          ...worktrees
            .filter((entry) => entry.isDirectory())
            .map((entry) => path.join(gitDir, "worktrees", entry.name, "FETCH_HEAD")),
        ]
      : [];
    const refreshed = await Promise.all(
      fetchPaths.map(async (filename) => {
        const stat = await fs.stat(filename).catch(() => null);
        return stat && Math.trunc(stat.mtimeMs) > failedAtMs ? filename : null;
      }),
    );
    if (refreshed.some((filename) => filename !== null)) {
      const branch = params.branch === "HEAD" ? DEV_BRANCH : params.branch;
      const [mergeRef, remote] = await Promise.all([
        params.readGit("config", "--get", `branch.${branch}.merge`),
        params.readGit("config", "--get", `branch.${branch}.remote`),
      ]);
      const branchRef = mergeRef ?? (params.branch === "HEAD" ? `refs/heads/${DEV_BRANCH}` : null);
      const remoteName = remote ?? (params.branch === "HEAD" ? "origin" : null);
      const remoteUrl = remoteName
        ? await params.readGit("remote", "get-url", "--", remoteName)
        : null;
      const source = remoteUrl ? describeFetchSource(remoteUrl) : null;
      // Relative remotes can resolve to different repositories in sibling worktrees.
      const currentFetch = source?.relative
        ? await params.readGit("rev-parse", "--git-path", "FETCH_HEAD")
        : null;
      const currentFetchPath = currentFetch ? path.resolve(params.root, currentFetch) : null;
      for (const filename of refreshed) {
        if (
          !filename ||
          !source ||
          !branchRef?.startsWith("refs/heads/") ||
          (source.relative && filename !== currentFetchPath)
        ) {
          continue;
        }
        const fetched = await fs.readFile(filename, "utf8").catch(() => "");
        if (
          fetched.split("\n").some((line) => {
            const [sha, , description] = line.split("\t");
            return (
              sha === params.upstreamCommit &&
              description === `branch '${branchRef.slice(11)}' of ${source.url}`
            );
          })
        ) {
          return undefined;
        }
      }
    }
  }
  // Never copy command output, remote URLs, or credentials into the status row.
  const detail = failedStep?.detail ?? "";
  return {
    reason: "fetch-failed",
    failedAtMs,
    detail: /would clobber existing tag/iu.test(detail)
      ? "tag conflict"
      : /authentication|permission denied|could not read Username|access denied/iu.test(detail)
        ? "authentication failed"
        : /resolve host|network|timed? out|timeout|unreachable/iu.test(detail)
          ? "network error"
          : "fetch-failed",
    runId: run.runId,
  };
}
