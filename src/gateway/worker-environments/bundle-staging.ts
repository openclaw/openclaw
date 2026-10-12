import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError, root, type Root } from "../../infra/fs-safe.js";
import {
  WORKER_BUNDLE_ARTIFACT_MODE,
  WORKER_BUNDLE_ARTIFACT_PATHS,
  WORKER_BUNDLE_CHUNK_PATH_PATTERN,
  compareWorkerBundlePaths,
  type WorkerBundleHashEntry,
} from "../../shared/worker-bundle-hash.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";

const WORKER_BUNDLE_STAGING_CONCURRENCY = 16;

async function stageWorkerDeployArtifact(params: {
  sourceRoot: string;
  source: Root;
  stagingRoot: string;
  artifactPath: string;
}): Promise<WorkerBundleHashEntry> {
  const relativeSourcePath = `dist/worker/${params.artifactPath}`;
  const { buffer } = await params.source
    .read(relativeSourcePath, { symlinks: "reject", hardlinks: "allow" })
    .catch((error: unknown) => {
      if (error instanceof FsSafeError && error.category === "policy") {
        throw new Error(`Unsafe worker deploy artifact: ${relativeSourcePath}`, { cause: error });
      }
      throw new Error(
        `OpenClaw worker deploy artifact is missing; build the running package at ${params.sourceRoot}`,
        { cause: error },
      );
    });
  // Stage exactly the hashed bytes so a concurrent rebuild cannot diverge archive and hash.
  await fs.writeFile(path.join(params.stagingRoot, params.artifactPath), buffer, {
    flag: "wx",
    mode: WORKER_BUNDLE_ARTIFACT_MODE,
  });
  return {
    path: params.artifactPath,
    mode: WORKER_BUNDLE_ARTIFACT_MODE,
    size: buffer.byteLength,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  };
}

export async function collectWorkerBundleManifest(
  sourceRoot: string,
  stagingRoot: string,
): Promise<WorkerBundleHashEntry[]> {
  const [source, artifacts] = await Promise.all([
    root(sourceRoot, { maxBytes: Infinity }),
    fs.readdir(path.join(sourceRoot, "dist/worker")),
  ]).catch((error: unknown) => {
    throw new Error(
      `OpenClaw worker deploy artifact is missing; build the running package at ${sourceRoot}`,
      { cause: error },
    );
  });
  const chunks = artifacts.filter((name) => WORKER_BUNDLE_CHUNK_PATH_PATTERN.test(name));
  // Drain in-flight writes before cleanup can remove staging and mask the original error.
  const { results, hasError, firstError } = await runTasksWithConcurrency({
    tasks: [...WORKER_BUNDLE_ARTIFACT_PATHS, ...chunks].map(
      (artifactPath) => () =>
        stageWorkerDeployArtifact({ sourceRoot, source, stagingRoot, artifactPath }),
    ),
    limit: WORKER_BUNDLE_STAGING_CONCURRENCY,
    errorMode: "stop",
  });
  if (hasError) {
    throw firstError;
  }
  return results.toSorted((left, right) => compareWorkerBundlePaths(left.path, right.path));
}
