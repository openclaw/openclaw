import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ControlUiBuildProvenance } from "../gateway/control-ui-contract.js";
import { resolveRuntimeServiceVersion, type RuntimeVersionEnv } from "../version.js";
import { resolveCommitHash } from "./git-commit.js";
import { resolveOpenClawPackageRootSync } from "./openclaw-root.js";

type PackageMetadata = {
  repository?: string | { url?: string | null } | null;
  version?: string | null;
};

function normalizeOptional(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeRepositoryUrl(repository: PackageMetadata["repository"]): string | null {
  if (typeof repository === "string") {
    return normalizeOptional(repository);
  }
  return normalizeOptional(repository?.url);
}

function readPackageMetadata(packageRoot: string | null): PackageMetadata {
  if (!packageRoot) {
    return {};
  }
  try {
    return JSON.parse(
      fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
    ) as PackageMetadata;
  } catch {
    return {};
  }
}

function resolveBuildTimestamp(env: RuntimeVersionEnv): string | null {
  const explicit = normalizeOptional(env.OPENCLAW_BUILD_TIMESTAMP ?? env.BUILD_TIMESTAMP);
  if (explicit) {
    return explicit;
  }
  const sourceDateEpoch = normalizeOptional(env.SOURCE_DATE_EPOCH);
  if (!sourceDateEpoch) {
    return null;
  }
  const epochSeconds = Number(sourceDateEpoch);
  return Number.isFinite(epochSeconds) ? new Date(epochSeconds * 1000).toISOString() : null;
}

function normalizeCommitSha(value: unknown): string | null {
  const normalized = normalizeOptional(value);
  const match = normalized?.match(/[0-9a-fA-F]{7,40}/);
  return match ? match[0].toLowerCase() : null;
}

function resolveCommitSha(params: {
  cwd?: string | null;
  env: RuntimeVersionEnv;
  moduleUrl: string;
}): string | null {
  return (
    normalizeCommitSha(params.env.GITHUB_SHA ?? params.env.GIT_COMMIT ?? params.env.GIT_SHA) ??
    resolveCommitHash({
      cwd: params.cwd ?? undefined,
      env: params.env,
      moduleUrl: params.moduleUrl,
    })
  );
}

function resolveCiRunId(env: RuntimeVersionEnv): string | null {
  return normalizeOptional(env.GITHUB_RUN_ID ?? env.CI_PIPELINE_ID ?? env.BUILD_BUILDID);
}

function resolveLockfileSha256(packageRoot: string | null): string | null {
  if (!packageRoot) {
    return null;
  }
  try {
    const contents = fs.readFileSync(path.join(packageRoot, "pnpm-lock.yaml"));
    return crypto.createHash("sha256").update(contents).digest("hex");
  } catch {
    return null;
  }
}

type ControlUiBuildProvenanceOptions = {
  env?: RuntimeVersionEnv;
  moduleUrl?: string;
  argv1?: string;
  cwd?: string;
};

const cachedDefaultProvenanceByModuleUrl = new Map<string, ControlUiBuildProvenance>();

export function resolveControlUiBuildProvenance(
  options: ControlUiBuildProvenanceOptions = {},
): ControlUiBuildProvenance {
  const env = options.env ?? (process.env as RuntimeVersionEnv);
  const moduleUrl = options.moduleUrl ?? import.meta.url;
  const packageRoot = resolveOpenClawPackageRootSync({
    cwd: options.cwd ?? process.cwd(),
    argv1: options.argv1 ?? process.argv[1],
    moduleUrl,
  });
  const packageMetadata = readPackageMetadata(packageRoot);

  return {
    sourceRepositoryUrl: normalizeRepositoryUrl(packageMetadata.repository),
    commitSha: resolveCommitSha({ cwd: packageRoot ?? options.cwd, env, moduleUrl }),
    buildTimestamp: resolveBuildTimestamp(env),
    packageVersion:
      normalizeOptional(packageMetadata.version) ?? resolveRuntimeServiceVersion(env, "unknown"),
    lockfileSha256: resolveLockfileSha256(packageRoot),
    ciRunId: resolveCiRunId(env),
  };
}

export function resolveCachedControlUiBuildProvenance(
  options: Omit<ControlUiBuildProvenanceOptions, "env" | "argv1" | "cwd"> = {},
): ControlUiBuildProvenance {
  const moduleUrl = options.moduleUrl ?? import.meta.url;
  const cached = cachedDefaultProvenanceByModuleUrl.get(moduleUrl);
  if (cached) {
    return cached;
  }
  const provenance = resolveControlUiBuildProvenance({ moduleUrl });
  cachedDefaultProvenanceByModuleUrl.set(moduleUrl, provenance);
  return provenance;
}
