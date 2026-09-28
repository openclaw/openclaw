import type { UpdateCheckResult } from "./update-check.js";

export function createDevGitStatus(params?: {
  currentSha?: string;
  branch?: string | null;
  upstream?: string | null;
  upstreamSource?: "tracking" | "receipt";
  upstreamSha?: string | null;
  repositoryUrl?: string;
  commitAtMs?: number | null;
  ahead?: number | null;
  behind?: number | null;
  fetchOk?: boolean;
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
      ...(params?.upstreamSource
        ? { upstreamSource: params.upstreamSource }
        : upstream
          ? { upstreamSource: "tracking" as const }
          : {}),
      upstreamSha: params?.upstreamSha === undefined ? "upstream-sha" : params.upstreamSha,
      ...(params?.repositoryUrl ? { repositoryUrl: params.repositoryUrl } : {}),
      commitAtMs: params?.commitAtMs ?? null,
      dirty: false,
      ahead: params?.ahead === undefined ? 0 : params.ahead,
      behind: params?.behind === undefined ? 2 : params.behind,
      fetchOk: params?.fetchOk ?? true,
    },
  } satisfies UpdateCheckResult;
  return status;
}
