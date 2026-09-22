import fs from "node:fs/promises";
import path from "node:path";
import { sha256File } from "../../infra/directory-durability.js";
import { root, type Root } from "../../infra/fs-safe.js";
import {
  WORKER_BUNDLE_ARTIFACT_MODE,
  WORKER_BUNDLE_ENTRY_PATH,
  WORKER_BUNDLE_GITHUB_EXEC_LAUNCHER_PATH,
  WORKER_BUNDLE_RSYNC_RECEIVER_PATH,
} from "../../shared/worker-bundle-hash.js";

const WORKER_DEPLOY_ARTIFACT_PATHS = [
  WORKER_BUNDLE_GITHUB_EXEC_LAUNCHER_PATH,
  WORKER_BUNDLE_ENTRY_PATH,
  WORKER_BUNDLE_RSYNC_RECEIVER_PATH,
] as const;

export type WorkerBundleManifestEntry = {
  path: string;
  mode: number;
  size: number;
  sha256: string;
};

async function stageWorkerDeployArtifact(params: {
  sourceRoot: string;
  source: Root;
  staging: Root;
  artifactPath: (typeof WORKER_DEPLOY_ARTIFACT_PATHS)[number];
}): Promise<WorkerBundleManifestEntry> {
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
): Promise<WorkerBundleManifestEntry[]> {
  const source = await root(sourceRoot, { maxBytes: Infinity }).catch((error: unknown) => {
    throw new Error(
      `OpenClaw worker deploy artifact is missing; build the running package at ${sourceRoot}`,
      { cause: error },
    );
  });
  const staging = await root(stagingRoot, { maxBytes: Infinity });
  const manifest: WorkerBundleManifestEntry[] = [];
  for (const artifactPath of WORKER_DEPLOY_ARTIFACT_PATHS) {
    manifest.push(await stageWorkerDeployArtifact({ sourceRoot, source, staging, artifactPath }));
  }
  return manifest;
}
