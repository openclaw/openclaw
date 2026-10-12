import { createHash, randomUUID } from "node:crypto";
import { createReadStream, type Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import * as tar from "tar";
import { resolveStateDir } from "../../config/paths.js";
import { sha256File } from "../../infra/directory-durability.js";
import { isExactSemverVersion, resolveNpmJsonEntries } from "../../infra/npm-registry-spec.js";
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { createLazyPromise } from "../../shared/lazy-promise.js";
import {
  DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
  readWorkerBundleArchiveManifest,
} from "../../shared/worker-bundle-archive.js";
import {
  compareWorkerBundlePaths,
  hashWorkerBundleManifest,
  WORKER_BUNDLE_ARTIFACT_MODE,
  WORKER_BUNDLE_ARTIFACT_PATHS,
  WORKER_BUNDLE_CHUNK_PATH_PATTERN,
  type WorkerBundleHashEntry,
} from "../../shared/worker-bundle-hash.js";
import { VERSION } from "../../version.js";
import type { ExpectedWorkerBuild } from "../../worker/worker-build-identity.js";
import { collectWorkerBundleManifest } from "./bundle-staging.js";

const OPENCLAW_NPM_REGISTRY = "https://registry.npmjs.org/";
const NPM_RELEASE_PROOF_TIMEOUT_MS = 60_000;
const NPM_SHA512_INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const BUNDLE_TARBALL_NAME_PATTERN = /^([a-f0-9]{64})\.tgz$/u;
const BUNDLE_STAGING_NAME_PATTERN = /^\.staging-[A-Za-z0-9_-]+$/u;
const BUNDLE_TEMP_NAME_PATTERN = /^[a-f0-9]{64}\.tgz\.[0-9]+\.[0-9a-f-]{36}\.tmp$/u;
const PACKAGED_BUNDLE_NAME_PATTERN = /^([a-f0-9]{64})\.tar\.gz$/u;
const PACKAGED_BUNDLE_DIRECTORY = "dist/worker-artifacts";
type WorkerBundleArtifact = ExpectedWorkerBuild & {
  install: "bundle";
  tarballBytes: number;
  tarballSha256: string;
  tarballPath: string;
};

export type WorkerNpmArtifact = ExpectedWorkerBuild & {
  install: "npm";
  packageIntegrity: string;
  packageSpec: string;
};

export type WorkerInstallationArtifact = WorkerBundleArtifact | WorkerNpmArtifact;

export type WorkerBundleProducer = {
  prepare: () => Promise<WorkerBundleArtifact>;
  prune: (readRetainedBundleHashes: () => readonly string[]) => Promise<void>;
};

type WorkerBundleProducerOptions = {
  packageRoot?: string;
  cacheDir?: string;
  openclawVersion?: string;
  protocolFeatures?: readonly string[];
  cacheOwnership?: "exclusive";
  onCacheCleanupError?: (error: unknown) => void;
};

type WorkerNpmPackageInstallCheck = (packageRoot: string) => Promise<boolean>;
type WorkerNpmReleaseVerifier = (params: {
  bundleHash: string;
  version: string;
}) => Promise<string>;

function normalizeProtocolFeatures(features: readonly string[]): string[] {
  const normalized = features.map((feature) => feature.trim());
  if (normalized.some((feature) => feature.length === 0)) {
    throw new Error("Worker protocol features must be non-empty strings");
  }
  return [...new Set(normalized)].toSorted(compareWorkerBundlePaths);
}

function resolveBundleCacheDir(cacheDir: string | undefined): string {
  return cacheDir
    ? path.resolve(cacheDir)
    : path.join(resolveStateDir(), "cache", "worker-bundles");
}

function resolvePackageRoot(packageRoot: string | undefined): string {
  if (packageRoot) {
    return path.resolve(packageRoot);
  }
  const resolved = resolveOpenClawPackageRootSync({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
  if (!resolved) {
    throw new Error("Unable to locate the running OpenClaw package root for worker bundling");
  }
  return resolved;
}

async function isReleasedPackageInstall(packageRoot: string): Promise<boolean> {
  const entries = new Set(await fs.readdir(packageRoot));
  return (
    !entries.has(".git") &&
    !entries.has("pnpm-lock.yaml") &&
    !entries.has("bun.lock") &&
    !entries.has("bun.lockb")
  );
}

type NpmPackageIdentity = {
  filename?: string;
  name: string;
  version: string;
  integrity: string;
};

function parseNpmPackageIdentity(value: unknown): NpmPackageIdentity | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const name = normalizeOptionalString(value.name);
  const version = normalizeOptionalString(value.version);
  const integrity =
    normalizeOptionalString(value.integrity) ?? normalizeOptionalString(value["dist.integrity"]);
  const filename = normalizeOptionalString(value.filename);
  return name && version && integrity ? { name, version, integrity, filename } : undefined;
}

async function runNpmProofCommand(params: {
  argv: string[];
  cwd: string;
  failureMessage: string;
}): Promise<unknown> {
  try {
    const result = await runCommandWithTimeout(params.argv, {
      cwd: params.cwd,
      timeoutMs: NPM_RELEASE_PROOF_TIMEOUT_MS,
      env: {
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
        NPM_CONFIG_IGNORE_SCRIPTS: "true",
      },
    });
    if (result.code !== 0 || result.stdoutTruncatedBytes) {
      throw new Error(params.failureMessage);
    }
    return JSON.parse(result.stdout.trim()) as unknown;
  } catch {
    throw new Error(params.failureMessage);
  }
}

async function hashNpmTarballIntegrity(tarballPath: string): Promise<string> {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(tarballPath)) {
    hash.update(chunk);
  }
  return `sha512-${hash.digest("base64")}`;
}

async function verifyPublishedNpmRelease(params: {
  bundleHash: string;
  version: string;
}): Promise<string> {
  const temporaryRoot = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-worker-npm-proof-"),
  );
  try {
    const published = parseNpmPackageIdentity(
      resolveNpmJsonEntries(
        await runNpmProofCommand({
          argv: [
            "npm",
            "view",
            `openclaw@${params.version}`,
            "name",
            "version",
            "dist.integrity",
            "--json",
            `--registry=${OPENCLAW_NPM_REGISTRY}`,
          ],
          cwd: temporaryRoot,
          failureMessage: `OpenClaw ${params.version} is not published; use the worker bundle install`,
        }),
      )[0],
    );
    if (
      published?.name !== "openclaw" ||
      published.version !== params.version ||
      !NPM_SHA512_INTEGRITY_PATTERN.test(published.integrity)
    ) {
      throw new Error(
        `Cannot verify exact public npm release openclaw@${params.version}; use the worker bundle install`,
      );
    }
    const packedValue = await runNpmProofCommand({
      argv: [
        "npm",
        "pack",
        `openclaw@${params.version}`,
        "--pack-destination",
        temporaryRoot,
        "--ignore-scripts",
        "--json",
        `--registry=${OPENCLAW_NPM_REGISTRY}`,
      ],
      cwd: temporaryRoot,
      failureMessage:
        "Unable to verify the installed OpenClaw package; use the worker bundle install",
    });
    const packed = parseNpmPackageIdentity(resolveNpmJsonEntries(packedValue)[0]);
    if (!packed?.filename || path.basename(packed.filename) !== packed.filename) {
      throw new Error("npm pack returned incomplete worker package metadata");
    }
    const packedTarballPath = path.join(temporaryRoot, packed.filename);
    let packedTarballIntegrity: string;
    try {
      packedTarballIntegrity = await hashNpmTarballIntegrity(packedTarballPath);
    } catch {
      throw new Error(
        "Unable to verify the installed OpenClaw package; use the worker bundle install",
      );
    }
    if (
      packed.name !== published.name ||
      packed.version !== published.version ||
      packed.integrity !== published.integrity ||
      packedTarballIntegrity !== published.integrity
    ) {
      throw new Error(
        `Installed OpenClaw ${params.version} does not match the published package; use the worker bundle install`,
      );
    }
    const extractedRoot = path.join(temporaryRoot, "package");
    await fs.mkdir(extractedRoot);
    await tar.extract({
      cwd: extractedRoot,
      file: packedTarballPath,
      preservePaths: false,
      strict: true,
      strip: 1,
    });
    const packedBundle = await prepareWorkerBundle({
      packageRoot: extractedRoot,
      cacheDir: path.join(temporaryRoot, "bundle-cache"),
      openclawVersion: params.version,
    });
    if (packedBundle.bundleHash !== params.bundleHash) {
      throw new Error(
        `Published OpenClaw ${params.version} does not match the prepared worker bundle; use the worker bundle install`,
      );
    }
    return published.integrity;
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function isCachedTarball(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.lstat(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`Unsafe worker bundle cache path: ${filePath}`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function cachedTarballMatches(
  tarballPath: string,
  manifest: readonly WorkerBundleHashEntry[],
): Promise<boolean> {
  if (!(await isCachedTarball(tarballPath))) {
    return false;
  }
  try {
    return (
      hashWorkerBundleManifest(
        await readWorkerBundleArchiveManifest(tarballPath, DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS),
      ) === hashWorkerBundleManifest(manifest)
    );
  } catch {
    return false;
  }
}

async function writeTarball(params: {
  stagingRoot: string;
  entries: readonly WorkerBundleHashEntry[];
  tarballPath: string;
}): Promise<void> {
  const temporaryPath = `${params.tarballPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await tar.create(
      {
        cwd: params.stagingRoot,
        file: temporaryPath,
        gzip: true,
        noDirRecurse: true,
        noMtime: true,
        portable: true,
        strict: true,
        onWriteEntry: ({ stat }) => {
          if (stat) {
            stat.mode = (stat.mode & ~0o777) | WORKER_BUNDLE_ARTIFACT_MODE;
          }
        },
      },
      params.entries.map((entry) => entry.path),
    );
    try {
      await fs.rename(temporaryPath, params.tarballPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      // Another gateway process may have published the same content-addressed artifact.
      if (!(await cachedTarballMatches(params.tarballPath, params.entries))) {
        // Windows cannot replace an existing file with rename. The complete temp artifact
        // remains the publication source after the corrupt cache entry is removed.
        await fs.rm(params.tarballPath, { force: true });
        try {
          await fs.rename(temporaryPath, params.tarballPath);
        } catch (publishError) {
          if (
            (publishError as NodeJS.ErrnoException).code !== "EEXIST" ||
            !(await cachedTarballMatches(params.tarballPath, params.entries))
          ) {
            throw publishError;
          }
        }
      }
    }
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

async function pruneWorkerBundleCache(params: {
  cacheDir: string;
  currentBundleHash: string;
  readRetainedBundleHashes: () => readonly string[];
  onError?: (error: unknown) => void;
}): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(params.cacheDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      params.onError?.(error);
    }
    return;
  }
  const candidates = entries
    .map(({ name }) => ({
      name,
      bundleHash: BUNDLE_TARBALL_NAME_PATTERN.exec(name)?.[1],
      staging: BUNDLE_STAGING_NAME_PATTERN.test(name),
    }))
    .filter(
      ({ name, bundleHash, staging }) =>
        (bundleHash !== undefined && bundleHash !== params.currentBundleHash) ||
        staging ||
        BUNDLE_TEMP_NAME_PATTERN.test(name),
    );
  if (candidates.length === 0) {
    return;
  }
  // Read current references only after this queued prune finds possible cleanup work.
  const retained = new Set(
    [params.currentBundleHash, ...params.readRetainedBundleHashes()].filter((hash) =>
      /^[a-f0-9]{64}$/u.test(hash),
    ),
  );
  for (const entry of candidates.toSorted((left, right) =>
    compareWorkerBundlePaths(left.name, right.name),
  )) {
    if (entry.bundleHash !== undefined && retained.has(entry.bundleHash)) {
      continue;
    }
    const target = path.join(params.cacheDir, entry.name);
    try {
      const stats = await fs.lstat(target);
      if (stats.isSymbolicLink()) {
        continue;
      }
      if (entry.staging ? !stats.isDirectory() : !stats.isFile()) {
        continue;
      }
      await fs.rm(target, { recursive: entry.staging, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        params.onError?.(error);
      }
    }
  }
}

async function prepareWorkerBundle(
  options: WorkerBundleProducerOptions,
): Promise<WorkerBundleArtifact> {
  const packageRoot = resolvePackageRoot(options.packageRoot);
  const openclawVersion = (options.openclawVersion ?? VERSION).trim();
  if (!openclawVersion) {
    throw new Error("Worker bundle requires a non-empty OpenClaw version");
  }
  const protocolFeatures = normalizeProtocolFeatures(options.protocolFeatures ?? []);
  const packaged = await resolvePackagedWorkerBundle({
    packageRoot,
    openclawVersion,
    protocolFeatures,
  });
  if (packaged) {
    return packaged;
  }
  const cacheDir = resolveBundleCacheDir(options.cacheDir);
  await fs.mkdir(cacheDir, { recursive: true });
  const stagingRoot = await fs.mkdtemp(path.join(cacheDir, ".staging-"));
  try {
    // Stage the exact bytes and modes first so a concurrent dev rebuild cannot make the
    // archived payload diverge from its content hash.
    const manifest = await collectWorkerBundleManifest(packageRoot, stagingRoot);
    const bundleHash = hashWorkerBundleManifest(manifest);
    const tarballPath = path.join(cacheDir, `${bundleHash}.tgz`);
    if (!(await cachedTarballMatches(tarballPath, manifest))) {
      await writeTarball({ stagingRoot, entries: manifest, tarballPath });
    }
    await using handle = await fs.open(tarballPath, "r");
    return {
      install: "bundle",
      bundleHash,
      openclawVersion,
      protocolFeatures,
      tarballBytes: (await fs.stat(tarballPath)).size,
      tarballSha256: (await sha256File(handle)).digest,
      tarballPath,
    };
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}

async function resolvePackagedWorkerBundle(params: {
  packageRoot: string;
  openclawVersion: string;
  protocolFeatures: string[];
}): Promise<WorkerBundleArtifact | null> {
  try {
    await fs.access(path.join(params.packageRoot, "dist/worker"));
    return null;
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  const archiveDirectory = path.join(params.packageRoot, PACKAGED_BUNDLE_DIRECTORY);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(archiveDirectory, { withFileTypes: true });
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (entries.length !== 1 || !entries[0]!.isFile()) {
    throw new Error("Packaged worker bundle must contain exactly one regular archive");
  }
  const match = PACKAGED_BUNDLE_NAME_PATTERN.exec(entries[0]!.name);
  if (!match) {
    throw new Error("Packaged worker bundle archive name is invalid");
  }
  const tarballPath = path.join(archiveDirectory, entries[0]!.name);
  const manifest = await readWorkerBundleArchiveManifest(
    tarballPath,
    DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
  );
  const paths = new Set(manifest.map((entry) => entry.path));
  const requiredPaths = new Set<string>(WORKER_BUNDLE_ARTIFACT_PATHS);
  if (
    WORKER_BUNDLE_ARTIFACT_PATHS.some((artifactPath) => !paths.has(artifactPath)) ||
    manifest.some(
      (entry) =>
        !requiredPaths.has(entry.path) && !WORKER_BUNDLE_CHUNK_PATH_PATTERN.test(entry.path),
    )
  ) {
    throw new Error("Packaged worker bundle archive does not match the worker artifact contract");
  }
  const bundleHash = hashWorkerBundleManifest(manifest);
  if (bundleHash !== match[1]) {
    throw new Error("Packaged worker bundle archive name does not match its manifest hash");
  }
  await using handle = await fs.open(tarballPath, "r");
  return {
    install: "bundle",
    bundleHash,
    openclawVersion: params.openclawVersion,
    protocolFeatures: params.protocolFeatures,
    tarballBytes: (await handle.stat()).size,
    tarballSha256: (await sha256File(handle)).digest,
    tarballPath,
  };
}

/** Creates a process-lifecycle bundle producer that scans the running build at most once. */
export function createWorkerBundleProducer(
  options: WorkerBundleProducerOptions = {},
): WorkerBundleProducer {
  let currentArtifact: WorkerBundleArtifact | undefined;
  let pruning = Promise.resolve();
  return {
    prepare: createLazyPromise(async () => {
      currentArtifact = await prepareWorkerBundle(options);
      return currentArtifact;
    }),
    async prune(readRetainedBundleHashes) {
      const artifact = currentArtifact;
      if (options.cacheOwnership !== "exclusive" || !artifact) {
        return;
      }
      const operation = pruning.then(async () => {
        await pruneWorkerBundleCache({
          cacheDir: resolveBundleCacheDir(options.cacheDir),
          currentBundleHash: artifact.bundleHash,
          readRetainedBundleHashes,
          onError: options.onCacheCleanupError,
        });
      });
      pruning = operation.catch(() => undefined);
      await operation;
    },
  };
}

/**
 * Selects the exact npm package only after the public tarball's canonical worker manifest proves
 * parity with the running gateway bundle.
 */
export async function resolveWorkerNpmInstallationArtifact(params: {
  bundle: WorkerBundleArtifact;
  packageRoot?: string;
  isPackageInstall?: WorkerNpmPackageInstallCheck;
  verifyRelease?: WorkerNpmReleaseVerifier;
}): Promise<WorkerNpmArtifact> {
  const version = params.bundle.openclawVersion.trim();
  if (!isExactSemverVersion(version)) {
    throw new Error(
      `Worker npm install requires the exact published gateway version; expected ${version}`,
    );
  }
  const packageRoot = resolvePackageRoot(params.packageRoot);
  const packageInstall = params.isPackageInstall
    ? await params.isPackageInstall(packageRoot)
    : await isReleasedPackageInstall(packageRoot);
  if (!packageInstall) {
    throw new Error(
      "Worker npm install requires the gateway to run from a packaged release install",
    );
  }
  const packageIntegrity = await (params.verifyRelease ?? verifyPublishedNpmRelease)({
    bundleHash: params.bundle.bundleHash,
    version,
  });
  return {
    install: "npm",
    bundleHash: params.bundle.bundleHash,
    openclawVersion: version,
    packageIntegrity,
    protocolFeatures: params.bundle.protocolFeatures,
    packageSpec: `openclaw@${version}`,
  };
}
