import fs from "node:fs/promises";
import path from "node:path";
import { root as openFsRoot } from "../../infra/fs-safe.js";
import {
  DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
  readWorkerBundleArchiveManifest,
} from "../../shared/worker-bundle-archive.js";
import { MAX_WORKER_BUNDLE_ARCHIVE_BYTES } from "../../shared/worker-bundle-limits.js";

/** Deployment-owned input; never write or remove this file in the running installation. */
export const NODE_BOOTSTRAP_PREBUILT_ARCHIVE = "node-runtime.tgz";

export async function copyNodeBootstrapPrebuiltArchive(packageRoot: string, temporaryRoot: string) {
  // The shared parser normalizes tar modes on Windows. Reuse must compare actual permissions,
  // including when the destination is Unix, so retain the builder on that host platform.
  if (process.platform === "win32") {
    return undefined;
  }
  const tarballPath = path.join(temporaryRoot, NODE_BOOTSTRAP_PREBUILT_ARCHIVE);
  const source = await openFsRoot(packageRoot, {
    symlinks: "reject",
    hardlinks: "allow",
    nonBlockingRead: true,
  });
  const destination = await openFsRoot(temporaryRoot);
  try {
    // Validate a bounded private copy: later image replacement cannot swap executable bytes
    // between manifest validation and the enrollment's authenticated download.
    await destination.copyIn(
      NODE_BOOTSTRAP_PREBUILT_ARCHIVE,
      { root: source, relativePath: NODE_BOOTSTRAP_PREBUILT_ARCHIVE },
      { maxBytes: MAX_WORKER_BUNDLE_ARCHIVE_BYTES, overwrite: false, durable: false, mode: 0o600 },
    );
    return await readWorkerBundleArchiveManifest(tarballPath, DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS);
  } catch {
    // Missing, unsafe or corrupt deployment input is a cache miss. The canonical builder
    // still verifies the running distribution and owns any preparation failure.
    await fs.rm(tarballPath, { force: true });
    return undefined;
  }
}
