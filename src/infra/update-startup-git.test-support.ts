import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { writeUpdateInstallReceiptRowSync } from "./restart-sentinel-store.js";
import type { UpdateCheckResult } from "./update-check.js";

export function createDevGitStatus(params?: {
  currentSha?: string;
  branch?: string | null;
  upstream?: string | null;
  upstreamSha?: string | null;
  repositoryUrl?: string;
  commitAtMs?: number | null;
  ahead?: number | null;
  behind?: number | null;
  fetchOk?: boolean | null;
}) {
  const upstream = params?.upstream === undefined ? "origin/main" : params.upstream;
  const status = {
    root: "/opt/openclaw",
    installKind: "git",
    packageManager: "pnpm",
    git: {
      root: "/opt/openclaw",
      sha: params?.currentSha ?? "current-sha",
      tag: null,
      branch: params?.branch === undefined ? "main" : params.branch,
      upstream,
      upstreamSha: params?.upstreamSha === undefined ? "upstream-sha" : params.upstreamSha,
      ...(params?.repositoryUrl ? { repositoryUrl: params.repositoryUrl } : {}),
      commitAtMs: params?.commitAtMs ?? null,
      dirty: false,
      ahead: params?.ahead === undefined ? 0 : params.ahead,
      behind: params?.behind === undefined ? 2 : params.behind,
      fetchOk: params?.fetchOk === undefined ? true : params.fetchOk,
    },
  } satisfies UpdateCheckResult;
  return status;
}

export function writeDevGitInstallReceipt(params: {
  status: "ok" | "error";
  ts: number;
  reason?: string;
}) {
  runOpenClawStateWriteTransaction(({ db }) => {
    writeUpdateInstallReceiptRowSync(db, {
      kind: "update",
      status: params.status,
      ts: params.ts,
      stats: {
        mode: "git",
        ...(params.reason ? { reason: params.reason } : {}),
        root: "/opt/openclaw",
        after: { sha: "current-sha", version: "1.0.0", upstreamRef: "origin/main" },
      },
    });
  });
}
