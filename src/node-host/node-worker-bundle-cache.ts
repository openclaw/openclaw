import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  validateWorkerAdmissionHandshake,
  type WorkerAdmissionHandshake,
} from "../../packages/gateway-protocol/src/index.js";
import { extractErrorCode, isMissingPathError } from "../infra/errors.js";
import { root as fsSafeRoot } from "../infra/fs-safe.js";
import { isPathInside } from "../infra/path-guards.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
  extractWorkerBundleArchive,
  readWorkerBundleDirectoryManifest,
} from "../shared/worker-bundle-archive.js";
import {
  hashWorkerBundleManifest,
  WORKER_BUNDLE_ENTRY_PATH,
  workerBundleArchiveRelativePath,
} from "../shared/worker-bundle-hash.js";
import { MAX_WORKER_BUNDLE_ARCHIVE_BYTES } from "../shared/worker-bundle-limits.js";
import type { NodeWorkerBundlePreparationInput } from "../worker/node-bundle-install-protocol.js";
import { sameWorkerBuild } from "../worker/worker-build-identity.js";
import {
  packagedNodeWorkerBundleDirectory,
  resolveNodeWorkerBundleDirectory,
} from "./node-worker-bundle-paths.js";
import { prewarmNodeWorkerBundle } from "./node-worker-bundle-prewarm.js";
import { snapshotNodeWorkerEnv } from "./node-worker-environment.js";
import { replaceNodeWorkerDirectory } from "./node-worker-workspace-replacement.js";

const INSTALL_RECEIPT = "bootstrap-receipt.json";
const INSTALL_IGNORED_TOP_LEVEL = new Set([INSTALL_RECEIPT]);
const log = createSubsystemLogger("node/worker-bundle");

export async function verifyBundleArchive(params: {
  destination: string;
  archive: NodeWorkerBundlePreparationInput["archive"];
  signal?: AbortSignal;
}): Promise<void> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(params.destination, { signal: params.signal })) {
    bytes += chunk.byteLength;
    if (bytes > params.archive.bytes || bytes > MAX_WORKER_BUNDLE_ARCHIVE_BYTES) {
      throw new Error("worker bundle archive exceeded its byte limit");
    }
    hash.update(chunk);
  }
  params.signal?.throwIfAborted();
  if (bytes !== params.archive.bytes || hash.digest("hex") !== params.archive.sha256) {
    throw new Error("worker bundle archive failed integrity validation");
  }
}

export async function readNodeWorkerBundleReceipt(
  bundleDir: string,
): Promise<WorkerAdmissionHandshake | undefined> {
  try {
    await using file = await fsp.open(
      path.join(bundleDir, INSTALL_RECEIPT),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024) {
      return undefined;
    }
    const raw: unknown = JSON.parse(await file.readFile("utf8"));
    return validateWorkerAdmissionHandshake(raw) ? raw : undefined;
  } catch (error) {
    // Missing or malformed cache receipts are repaired by the next installation.
    if (!isMissingPathError(error) && !(error instanceof SyntaxError)) {
      log.warn(
        "Worker bundle receipt read failed; treating installation as missing. Check node-host storage permissions and disk health.",
        { errorCode: extractErrorCode(error) },
      );
    }
    return undefined;
  }
}

export async function validateInstalledBundle(
  destination: string,
  expected: WorkerAdmissionHandshake,
): Promise<boolean> {
  try {
    const bundleDir = resolveNodeWorkerBundleDirectory(destination, expected.bundleHash);
    const rootStats = await fsp.lstat(bundleDir);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      return false;
    }
    const receipt = await readNodeWorkerBundleReceipt(bundleDir);
    if (!receipt || !sameWorkerBuild(receipt, expected)) {
      return false;
    }
    const manifest = await readWorkerBundleDirectoryManifest({
      root: bundleDir,
      limits: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
      ignoreTopLevel: INSTALL_IGNORED_TOP_LEVEL,
    });
    if (hashWorkerBundleManifest(manifest) !== expected.bundleHash) {
      return false;
    }
    const root = await fsp.realpath(bundleDir);
    const entry = await fsp.realpath(path.join(root, WORKER_BUNDLE_ENTRY_PATH));
    return isPathInside(root, entry) && (await fsp.stat(entry)).isFile();
  } catch (error) {
    // Invalid inventory is regenerable; filesystem failures still need a diagnostic.
    const errorCode = extractErrorCode(error);
    if (errorCode && !isMissingPathError(error)) {
      log.warn(
        "Worker bundle cache read failed; treating installation as missing. Check node-host storage permissions and disk health.",
        { errorCode },
      );
    }
    return false;
  }
}

export async function publishExpandedBundle(params: {
  archivePath: string;
  staging: string;
  destination: string;
  build: WorkerAdmissionHandshake;
  signal?: AbortSignal;
}): Promise<void> {
  await extractWorkerBundleArchive({
    tarballPath: params.archivePath,
    destination: params.staging,
    expectedBundleHash: params.build.bundleHash,
    limits: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
  });
  params.signal?.throwIfAborted();
  const receipt = await fsp.open(path.join(params.staging, INSTALL_RECEIPT), "wx", 0o600);
  try {
    params.signal?.throwIfAborted();
    await receipt.writeFile(`${JSON.stringify(params.build)}\n`);
    await receipt.sync();
  } finally {
    await receipt.close();
  }
  await replaceNodeWorkerDirectory(params.destination, params.staging, "bundle", params.signal);
  if (!(await validateInstalledBundle(params.destination, params.build))) {
    throw new Error("published worker bundle failed validation");
  }
}

/** Prepare package-owned code without a lease, enrollment, or process readiness claim. */
export async function preparePackagedNodeWorkerBundle(
  input: NodeWorkerBundlePreparationInput,
  verifyOnly = false,
): Promise<void> {
  const destination = packagedNodeWorkerBundleDirectory(input.build.bundleHash);
  if (!destination) {
    throw new Error("Worker bundle package root is unavailable");
  }
  if (await validateInstalledBundle(destination, input.build)) {
    if (!verifyOnly) {
      await prewarmNodeWorkerBundle({
        directory: destination,
        env: snapshotNodeWorkerEnv(process.env),
      });
    }
    return;
  }
  if (verifyOnly) {
    throw new Error("Prepared expanded worker bundle is missing or invalid");
  }
  const packageRoot = path.resolve(destination, "../../..");
  const relative = workerBundleArchiveRelativePath(input.archive.sha256);
  const root = await fsSafeRoot(packageRoot);
  await using archive = await root.open(relative);
  if (archive.stat.size !== input.archive.bytes) {
    throw new Error("Prepared worker bundle archive length differs");
  }
  const archivePath = path.join(packageRoot, relative);
  await verifyBundleArchive({ destination: archivePath, archive: input.archive });
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const operationRoot = await fsp.mkdtemp(
    path.join(path.dirname(destination), ".staging-" + input.build.bundleHash + "-"),
  );
  try {
    await publishExpandedBundle({
      archivePath,
      staging: path.join(operationRoot, "root"),
      destination,
      build: input.build,
    });
    await prewarmNodeWorkerBundle({
      directory: destination,
      env: snapshotNodeWorkerEnv(process.env),
    });
  } finally {
    await fsp.rm(operationRoot, { recursive: true, force: true });
  }
}
