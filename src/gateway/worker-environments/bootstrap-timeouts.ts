import type { WorkerInstallationArtifact } from "./bundle.js";

export const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 10 * 60_000;
const BUNDLE_TRANSFER_MIN_THROUGHPUT_BYTES_PER_SECOND = 125_000;
const BUNDLE_TRANSFER_TIMEOUT_MAX_MS = 60 * 60_000;
const BOOTSTRAP_OPERATION_HEADROOM_MS = 5 * 60_000;
export const NODE_ENROLLMENT_TIMEOUT_MS = 10 * 60_000;
export const MAX_NODE_BOOTSTRAP_TIMEOUT_MS =
  DEFAULT_BOOTSTRAP_TIMEOUT_MS * 3 +
  BUNDLE_TRANSFER_TIMEOUT_MAX_MS +
  BOOTSTRAP_OPERATION_HEADROOM_MS +
  NODE_ENROLLMENT_TIMEOUT_MS;

// Scale transfer time for congested uplinks (~243 MB at <4 Mbps exceeds 10 minutes).
// The base timeout remains the floor; the cap keeps transfer bounded and fail-closed.
export function bundleTransferTimeoutMs(tarballBytes: number, floorMs: number): number {
  if (!Number.isSafeInteger(tarballBytes) || tarballBytes < 0) {
    throw new Error("Worker bundle artifact has an invalid tarball size");
  }
  return Math.min(
    BUNDLE_TRANSFER_TIMEOUT_MAX_MS,
    Math.max(
      floorMs,
      Math.ceil(tarballBytes / BUNDLE_TRANSFER_MIN_THROUGHPUT_BYTES_PER_SECOND) * 1000,
    ),
  );
}

type BootstrapArtifact = WorkerInstallationArtifact | { tarballBytes: number };

/** Bounds the complete bootstrap lifecycle without preempting any permitted phase. */
export function workerBootstrapOperationTimeoutMs(artifact: BootstrapArtifact): number {
  const transferTimeoutMs =
    "tarballBytes" in artifact
      ? bundleTransferTimeoutMs(artifact.tarballBytes, DEFAULT_BOOTSTRAP_TIMEOUT_MS)
      : 0;
  return DEFAULT_BOOTSTRAP_TIMEOUT_MS * 3 + transferTimeoutMs + BOOTSTRAP_OPERATION_HEADROOM_MS;
}
