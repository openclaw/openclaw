import fs from "node:fs/promises";
import path from "node:path";
import { sha256File } from "../../infra/directory-durability.js";
import { root, type Root } from "../../infra/fs-safe.js";
import {
  WORKER_BUNDLE_ARTIFACT_MODE,
  WORKER_BUNDLE_ARTIFACT_PATHS,
  WORKER_BUNDLE_CHUNK_PATH_PATTERN,
  compareWorkerBundlePaths,
  type WorkerBundleHashEntry,
} from "../../shared/worker-bundle-hash.js";

async function stageWorkerDeployArtifact(params: {
  sourceRoot: string;
  source: Root;
  staging: Root;
  artifactPath: string;
}): Promise<WorkerBundleHashEntry> {
  const relativeSourcePath = `dist/worker/${params.artifactPath}`;
  const sourcePath = path.join(params.sourceRoot, relativeSourcePath);
  let expectedRealPath: string;
  try {
    expectedRealPath = await fs.realpath(sourcePath);
  } catch (error) {
    throw new Error(
      `OpenClaw worker deploy artifact is missing; build the running package at ${params.sourceRoot}`,
      { cause: error },
    );
  }
  const expectedPath = path.resolve(params.sourceRoot, relativeSourcePath);
  if (expectedRealPath !== expectedPath) {
    throw new Error(`Unsafe worker deploy artifact: ${relativeSourcePath}`);
  }
  const initialStats = await fs.lstat(sourcePath);
  if (initialStats.isSymbolicLink() || !initialStats.isFile()) {
    throw new Error(`Unsafe worker deploy artifact: ${relativeSourcePath}`);
  }
  await params.staging.copyIn(
    params.artifactPath,
    { root: params.source, relativePath: sourcePath },
    {
      overwrite: false,
      sourceHardlinks: "allow",
      mode: WORKER_BUNDLE_ARTIFACT_MODE,
      maxBytes: Infinity,
      durable: false,
      clone: "never",
    },
  );
  const opened = await params.staging.open(params.artifactPath);
  try {
    const { bytes, digest } = await sha256File(opened.handle, { maxBytes: opened.stat.size });
    if (bytes !== opened.stat.size) {
      throw new Error(`Worker deploy artifact changed while packaging: ${relativeSourcePath}`);
    }
    return {
      path: params.artifactPath,
      mode: WORKER_BUNDLE_ARTIFACT_MODE,
      size: bytes,
      sha256: digest,
    };
  } finally {
    await opened.handle.close();
  }
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
  const staging = await root(stagingRoot, { maxBytes: Infinity });
  const manifest: WorkerBundleHashEntry[] = [];
  const chunks = artifacts.filter((name) => WORKER_BUNDLE_CHUNK_PATH_PATTERN.test(name));
  for (const artifactPath of [...WORKER_BUNDLE_ARTIFACT_PATHS, ...chunks]) {
    manifest.push(await stageWorkerDeployArtifact({ sourceRoot, source, staging, artifactPath }));
  }
  return manifest.toSorted((left, right) => compareWorkerBundlePaths(left.path, right.path));
}
