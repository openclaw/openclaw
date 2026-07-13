import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { listGitWorktrees, requireGit, runGit } from "./git.js";

export type ResolvedWorktreeRepository = {
  requestedPath: string;
  repoRoot: string;
  sourceRoot: string;
  commonDir: string;
  originUrl: string;
  fingerprint: string;
};

export function assertWorktreeRepositoryIdentity(
  repository: ResolvedWorktreeRepository,
  expected: {
    sourcePath?: string;
    sourceRoot?: string;
    commonDir?: string;
    fingerprint?: string;
  },
): void {
  if (
    (expected.sourcePath && repository.requestedPath !== expected.sourcePath) ||
    (expected.sourceRoot && repository.sourceRoot !== expected.sourceRoot) ||
    (expected.commonDir && repository.commonDir !== expected.commonDir) ||
    (expected.fingerprint && repository.fingerprint !== expected.fingerprint)
  ) {
    throw new Error("repository identity changed after authorization");
  }
}

export async function resolveWorktreeRepository(
  repoRoot: string,
): Promise<ResolvedWorktreeRepository> {
  const requestedPath = await fs.realpath(repoRoot).catch(() => {
    throw new Error(`repository does not exist: ${repoRoot}`);
  });
  const rootResult = await runGit(requestedPath, ["rev-parse", "--show-toplevel"]);
  if (rootResult.code !== 0) {
    throw new Error(`not a git checkout: ${repoRoot}`);
  }
  const sourceRoot = await fs.realpath(rootResult.stdout.trim());
  const commonRaw = await requireGit(sourceRoot, ["rev-parse", "--git-common-dir"]);
  const commonDir = await fs.realpath(
    path.isAbsolute(commonRaw) ? commonRaw : path.resolve(sourceRoot, commonRaw),
  );
  const primary = (await listGitWorktrees(sourceRoot))[0]?.path ?? sourceRoot;
  const canonicalRoot = await fs.realpath(primary);
  const origin = await runGit(canonicalRoot, ["config", "--get", "remote.origin.url"]);
  const originUrl = origin.code === 0 ? origin.stdout.trim() : "";
  const fingerprint = createHash("sha256")
    .update(`${commonDir}\n${originUrl}`)
    .digest("hex")
    .slice(0, 16);
  return { requestedPath, repoRoot: canonicalRoot, sourceRoot, commonDir, originUrl, fingerprint };
}
