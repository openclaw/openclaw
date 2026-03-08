import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import {
  REPO_OWNERSHIP_FILENAME,
  type LoadedRepoOwnershipMap,
  type RepoOwnershipMap,
} from "./types.js";
import { validateRepoOwnershipMap } from "./validate.js";

type ResolveRepoOwnershipMapPathOptions = {
  filePath?: string;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function assertRepoOwnershipMapShape(value: unknown): asserts value is RepoOwnershipMap {
  if (!value || typeof value !== "object") {
    throw new Error("repoOwnership map must be an object");
  }

  const candidate = value as {
    version?: unknown;
    generatedAt?: unknown;
    repos?: unknown;
  };

  if (candidate.version !== "sre.repo-ownership-map.v1") {
    throw new Error(`unsupported repoOwnership version: ${String(candidate.version)}`);
  }
  if (typeof candidate.generatedAt !== "string" || !candidate.generatedAt.trim()) {
    throw new Error("repoOwnership.generatedAt must be a non-empty string");
  }
  if (!Array.isArray(candidate.repos)) {
    throw new Error("repoOwnership.repos must be an array");
  }

  for (const repo of candidate.repos) {
    if (!repo || typeof repo !== "object") {
      throw new Error("repoOwnership.repos[] must be objects");
    }
    const typedRepo = repo as Record<string, unknown>;
    if (typeof typedRepo.repoId !== "string" || typeof typedRepo.localPath !== "string") {
      throw new Error("repoOwnership.repos[] requires string repoId and localPath");
    }
    if (typedRepo.githubRepo !== undefined && typeof typedRepo.githubRepo !== "string") {
      throw new Error("repoOwnership.repos[].githubRepo must be a string when present");
    }
    if (
      !isStringArray(typedRepo.ownedGlobs) ||
      !isStringArray(typedRepo.sourceOfTruthDomains) ||
      !isStringArray(typedRepo.dependentRepos) ||
      !isStringArray(typedRepo.ciChecks) ||
      !isStringArray(typedRepo.validationCommands) ||
      !isStringArray(typedRepo.rollbackHints)
    ) {
      throw new Error(`repoOwnership ${typedRepo.repoId} has invalid list fields`);
    }
  }
}

export async function loadRepoOwnershipMap(filePath: string): Promise<LoadedRepoOwnershipMap> {
  const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  assertRepoOwnershipMapShape(raw);

  const baseDir = path.dirname(path.resolve(filePath));
  const loaded: LoadedRepoOwnershipMap = {
    version: raw.version,
    generatedAt: raw.generatedAt,
    repos: await Promise.all(
      raw.repos.map(async (repo) => {
        const resolvedLocalPath = path.resolve(baseDir, repo.localPath);
        const stat = await fs.stat(resolvedLocalPath);
        if (!stat.isDirectory()) {
          throw new Error(
            `repoOwnership ${repo.repoId} localPath is not a directory: ${resolvedLocalPath}`,
          );
        }
        return {
          ...repo,
          resolvedLocalPath,
        };
      }),
    ),
  };

  validateRepoOwnershipMap(loaded);
  return loaded;
}

export function resolveRepoOwnershipMapPath(options?: ResolveRepoOwnershipMapPathOptions): string {
  if (options?.filePath) {
    return path.resolve(options.filePath);
  }
  const env = options?.env ?? process.env;
  const stateDir = options?.stateDir ?? resolveStateDir(env, options?.homedir);
  const indexOverride = env.OPENCLAW_SRE_INDEX_DIR?.trim();
  const indexDir = indexOverride
    ? path.resolve(indexOverride)
    : path.join(stateDir, "state", "sre-index");
  return path.join(indexDir, REPO_OWNERSHIP_FILENAME);
}
