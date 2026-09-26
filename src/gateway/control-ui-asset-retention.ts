// Retains bounded, manifest-verified Control UI generations for already-open documents.
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Dirent, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isWithinDir } from "@openclaw/fs-safe/path";
import { resolveStateDir } from "../config/paths.js";
import { sha256File } from "../infra/directory-durability.js";
import { isErrno } from "../infra/errors.js";
import { copyFileHandle } from "../infra/file-descriptor.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseControlUiAssetManifest } from "./control-ui-asset-manifest-parse.js";
import {
  CONTROL_UI_ASSET_MANIFEST_FILENAME,
  type ControlUiAssetManifest,
  type ControlUiAssetManifestEntry,
} from "./control-ui-asset-manifest.js";

const CONTROL_UI_RETAINED_GENERATION_LIMIT = 3;
const CONTROL_UI_RETAINED_ASSET_MAX_BYTES = 96 * 1024 * 1024;

const CONTROL_UI_GENERATION_PATTERN = /^[a-f0-9]{64}$/u;
const CONTROL_UI_STAGING_PATTERN = /^\.staging-[0-9]+-[a-f0-9-]+$/u;
const CONTROL_UI_STAGING_MAX_AGE_MS = 60 * 60 * 1000;
const CONTROL_UI_MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
const log = createSubsystemLogger("gateway/control-ui-assets");

type RetainedGeneration = {
  assetPaths: ReadonlySet<string>;
  bytes: number;
  directory: string;
  generation: string;
  stats: Stats;
  realPath: string;
};

type ResolvedRetainedControlUiAsset = {
  filePath: string;
  rootPath: string;
  rootRealPath: string;
};

export type ControlUiAssetRetention = {
  prepare: (options?: { signal?: AbortSignal }) => Promise<void>;
  resolveAsset: (assetPath: string) => ResolvedRetainedControlUiAsset | null;
};

function resolveControlUiAssetCacheDir(): string {
  return path.join(resolveStateDir(), "cache", "control-ui-assets");
}

async function readCachedGeneration(
  directory: string,
  signal?: AbortSignal,
): Promise<RetainedGeneration | null> {
  try {
    signal?.throwIfAborted();
    const stats = await fs.lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return null;
    }
    const realPath = await fs.realpath(directory);
    if (!isWithinDir(path.dirname(directory), realPath)) {
      return null;
    }
    const manifest = await readAssetManifest(realPath, signal);
    if (manifest.generation !== path.basename(directory)) {
      return null;
    }
    for (const asset of manifest.assets) {
      await verifyAsset({
        entry: asset,
        signal,
        root: realPath,
        rootRealPath: realPath,
      });
    }
    const currentStats = await fs.lstat(directory);
    signal?.throwIfAborted();
    if (!sameDirectory(stats, currentStats)) {
      return null;
    }
    return {
      assetPaths: new Set(manifest.assets.map((asset) => asset.path)),
      bytes: manifest.assets.reduce((total, asset) => total + asset.size, 0),
      directory,
      generation: manifest.generation,
      stats: currentStats,
      realPath,
    };
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

function sameDirectory(left: Stats, right: Stats): boolean {
  return (
    right.isDirectory() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

function compareGenerations(left: RetainedGeneration, right: RetainedGeneration): number {
  return (
    right.stats.mtimeMs - left.stats.mtimeMs || left.generation.localeCompare(right.generation)
  );
}

async function readCacheInventory(
  cacheDir: string,
  signal?: AbortSignal,
  verified: RetainedGeneration[] = [],
) {
  const generations: RetainedGeneration[] = [];
  const directories = new Map<string, Stats>();
  let cacheRealPath: string;
  let entries: Dirent[];
  try {
    signal?.throwIfAborted();
    cacheRealPath = await fs.realpath(cacheDir);
    entries = await fs.readdir(cacheRealPath, { withFileTypes: true });
  } catch {
    signal?.throwIfAborted();
    return { generations, directories };
  }
  const known = new Map(verified.map((generation) => [generation.generation, generation]));
  for (const entry of entries) {
    signal?.throwIfAborted();
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }
    const directory = path.join(cacheRealPath, entry.name);
    const stats = await fs.lstat(directory).catch(() => null);
    if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) {
      continue;
    }
    directories.set(directory, stats);
    if (!CONTROL_UI_GENERATION_PATTERN.test(entry.name)) {
      continue;
    }
    const previous = known.get(entry.name);
    // Published directories are immutable. Refresh membership/mtime, but only
    // verify bytes for a new directory identity during this preparation.
    const generation =
      previous && sameDirectory(previous.stats, stats)
        ? { ...previous, stats }
        : await readCachedGeneration(directory, signal);
    if (generation) {
      generations.push(generation);
    }
  }
  signal?.throwIfAborted();
  return { generations: generations.toSorted(compareGenerations), directories };
}

async function readAssetManifest(
  root: string,
  signal?: AbortSignal,
): Promise<ControlUiAssetManifest> {
  const manifestPath = path.join(root, CONTROL_UI_ASSET_MANIFEST_FILENAME);
  signal?.throwIfAborted();
  const stats = await fs.lstat(manifestPath);
  signal?.throwIfAborted();
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size > CONTROL_UI_MANIFEST_MAX_BYTES) {
    throw new Error(`Invalid Control UI asset manifest: ${manifestPath}`);
  }
  const manifest = parseControlUiAssetManifest(
    JSON.parse(await fs.readFile(manifestPath, { encoding: "utf8", signal })),
  );
  signal?.throwIfAborted();
  if (!manifest) {
    throw new Error(`Invalid Control UI asset manifest: ${manifestPath}`);
  }
  return manifest;
}

async function verifyAsset(params: {
  destination?: string;
  entry: ControlUiAssetManifestEntry;
  signal?: AbortSignal;
  root: string;
  rootRealPath: string;
}): Promise<void> {
  params.signal?.throwIfAborted();
  const sourcePath = path.resolve(params.root, params.entry.path);
  if (!isWithinDir(params.root, sourcePath)) {
    throw new Error(`Unsafe Control UI asset path: ${params.entry.path}`);
  }
  const expectedRealPath = await fs.realpath(sourcePath);
  if (!isWithinDir(params.rootRealPath, expectedRealPath)) {
    throw new Error(`Unsafe Control UI asset path: ${params.entry.path}`);
  }
  const initialStats = await fs.lstat(sourcePath);
  if (initialStats.isSymbolicLink() || !initialStats.isFile()) {
    throw new Error(`Unsafe Control UI asset: ${params.entry.path}`);
  }
  const source = await fs.open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let destination: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    if (params.destination) {
      destination = await fs.open(
        params.destination,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          (fsConstants.O_NOFOLLOW ?? 0),
        0o600,
      );
    }
    const options = { maxBytes: params.entry.size, signal: params.signal };
    let bytes: number;
    let digest: string;
    if (destination) {
      const hash = createHash("sha256");
      bytes = await copyFileHandle(source, destination, {
        ...options,
        onChunk: (chunk) => {
          hash.update(chunk);
        },
      });
      digest = hash.digest("hex");
    } else {
      ({ bytes, digest } = await sha256File(source, options));
    }
    const openedStats = await source.stat();
    const currentStats = await fs.lstat(sourcePath);
    const currentRealPath = await fs.realpath(sourcePath);
    if (
      !openedStats.isFile() ||
      openedStats.size !== params.entry.size ||
      currentStats.isSymbolicLink() ||
      !currentStats.isFile() ||
      currentRealPath !== expectedRealPath ||
      currentStats.dev !== openedStats.dev ||
      currentStats.ino !== openedStats.ino ||
      bytes !== params.entry.size ||
      digest !== params.entry.sha256
    ) {
      throw new Error(`Control UI asset changed while being retained: ${params.entry.path}`);
    }
    params.signal?.throwIfAborted();
  } finally {
    await Promise.allSettled([source.close(), destination?.close()]);
  }
}

async function publishGeneration(params: {
  cacheDir: string;
  manifest: ControlUiAssetManifest;
  verified?: RetainedGeneration;
  signal?: AbortSignal;
  root: string;
}): Promise<RetainedGeneration> {
  const target = path.join(await fs.realpath(params.cacheDir), params.manifest.generation);
  // Another preparer may prune or replace the target after the initial inventory.
  const stats = await fs.lstat(target).catch((error: unknown) => {
    if (!isErrno(error) || error.code !== "ENOENT") {
      throw error;
    }
    return null;
  });
  const verified =
    stats &&
    (params.verified && sameDirectory(params.verified.stats, stats)
      ? params.verified
      : await readCachedGeneration(target, params.signal));
  if (verified) {
    params.signal?.throwIfAborted();
    await fs.utimes(target, new Date(), new Date());
    return verified;
  }

  const staging = path.join(params.cacheDir, `.staging-${process.pid}-${randomUUID()}`);
  params.signal?.throwIfAborted();
  await fs.mkdir(staging, { recursive: false, mode: 0o700 });
  try {
    const rootRealPath = await fs.realpath(params.root);
    let preparedDirectory: string | undefined;
    for (const entry of params.manifest.assets) {
      params.signal?.throwIfAborted();
      const destination = path.join(staging, entry.path);
      const directory = path.dirname(destination);
      // This preparer owns staging; adjacent assets can reuse its last created directory.
      if (directory !== preparedDirectory) {
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        preparedDirectory = directory;
      }
      await verifyAsset({
        destination,
        entry,
        signal: params.signal,
        root: params.root,
        rootRealPath,
      });
    }
    params.signal?.throwIfAborted();
    await fs.writeFile(
      path.join(staging, CONTROL_UI_ASSET_MANIFEST_FILENAME),
      `${JSON.stringify(params.manifest)}\n`,
      { mode: 0o600, signal: params.signal },
    );
    params.signal?.throwIfAborted();
    let collision: NodeJS.ErrnoException | undefined;
    try {
      await fs.rename(staging, target);
    } catch (error) {
      // Windows reports EPERM for a nonempty destination; verify the winner below.
      const collisionCodes =
        process.platform === "win32" ? ["EEXIST", "ENOTEMPTY", "EPERM"] : ["EEXIST", "ENOTEMPTY"];
      if (!isErrno(error) || !collisionCodes.includes(error.code ?? "")) {
        throw error;
      }
      collision = error;
    }
    const published = await readCachedGeneration(target, params.signal);
    if (!published) {
      throw collision ?? new Error(`Invalid retained Control UI generation: ${target}`);
    }
    params.signal?.throwIfAborted();
    await fs.utimes(target, new Date(), new Date());
    return published;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function pruneRetainedGenerations(params: {
  cacheDir: string;
  currentGeneration?: string;
  verified: RetainedGeneration[];
  now: number;
  signal?: AbortSignal;
}): Promise<RetainedGeneration[]> {
  const inventory = await readCacheInventory(params.cacheDir, params.signal, params.verified);
  const generations = inventory.generations.toSorted((left, right) => {
    if (left.generation === params.currentGeneration) {
      return -1;
    }
    if (right.generation === params.currentGeneration) {
      return 1;
    }
    return compareGenerations(left, right);
  });
  const retained = new Set<string>();
  let retainedBytes = 0;
  for (const generation of generations) {
    if (
      retained.size < CONTROL_UI_RETAINED_GENERATION_LIMIT &&
      retainedBytes + generation.bytes <= CONTROL_UI_RETAINED_ASSET_MAX_BYTES
    ) {
      retained.add(generation.generation);
      retainedBytes += generation.bytes;
    }
  }

  for (const [target, stats] of inventory.directories) {
    params.signal?.throwIfAborted();
    const name = path.basename(target);
    const generation = CONTROL_UI_GENERATION_PATTERN.test(name);
    const staleStaging =
      CONTROL_UI_STAGING_PATTERN.test(name) &&
      params.now - stats.mtimeMs >= CONTROL_UI_STAGING_MAX_AGE_MS;
    if ((!generation || retained.has(name)) && !staleStaging) {
      continue;
    }
    const currentStats = await fs.lstat(target).catch(() => null);
    params.signal?.throwIfAborted();
    // Never remove a replacement or a generation refreshed by another preparer.
    // Publications after this inventory belong to a later pruning pass.
    if (
      !currentStats ||
      !sameDirectory(stats, currentStats) ||
      stats.mtimeMs !== currentStats.mtimeMs
    ) {
      continue;
    }
    // Claim into a fresh container: the victim's old mtime must not make our
    // in-progress deletion eligible for another preparer's stale staging sweep.
    const staging = path.join(params.cacheDir, `.staging-${process.pid}-${randomUUID()}`);
    let owned = false;
    let claimed = false;
    try {
      await fs.mkdir(staging, { mode: 0o700 });
      owned = true;
      params.signal?.throwIfAborted();
      await fs.rename(target, path.join(staging, name));
      claimed = true;
      await fs.rm(staging, { recursive: true, force: true });
      log.debug("Control UI asset pruning completed", { directory: target, outcome: "pruned" });
    } catch (error) {
      params.signal?.throwIfAborted();
      const gone =
        !claimed &&
        (await fs.lstat(target).then(
          () => false,
          (cause: unknown) => isErrno(cause) && cause.code === "ENOENT",
        ));
      log[gone ? "debug" : "warn"]("Control UI asset pruning outcome", {
        directory: target,
        outcome: gone ? "already-pruned" : "deferred",
        error: String(error),
      });
    } finally {
      if (owned && !claimed) {
        await fs.rm(staging, { recursive: true, force: true }).catch((error: unknown) => {
          log.warn("Control UI asset pruning cleanup deferred", {
            directory: staging,
            outcome: "deferred",
            error: String(error),
          });
        });
      }
    }
  }
  const survivors: RetainedGeneration[] = [];
  for (const generation of inventory.generations) {
    if (!retained.has(generation.generation)) {
      continue;
    }
    const stats = await fs.lstat(generation.directory).catch(() => null);
    params.signal?.throwIfAborted();
    if (stats && sameDirectory(generation.stats, stats)) {
      survivors.push({ ...generation, stats });
    }
  }
  return survivors.toSorted(compareGenerations);
}

export function createControlUiAssetRetention(root: string): ControlUiAssetRetention {
  const cacheDir = resolveControlUiAssetCacheDir();
  let generations: RetainedGeneration[] = [];
  let preparing: Promise<void> | undefined;

  return {
    prepare({ signal } = {}) {
      preparing ??= (async () => {
        signal?.throwIfAborted();
        await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
        await fs.chmod(cacheDir, 0o700);
        const inventory = await readCacheInventory(cacheDir, signal);
        signal?.throwIfAborted();
        generations = inventory.generations;
        const verified = [...generations];
        const manifest = await readAssetManifest(root, signal);
        const manifestBytes = manifest.assets.reduce((total, asset) => total + asset.size, 0);
        if (manifestBytes <= CONTROL_UI_RETAINED_ASSET_MAX_BYTES) {
          const published = await publishGeneration({
            cacheDir,
            manifest,
            signal,
            root,
            verified: verified.find((entry) => entry.generation === manifest.generation),
          });
          verified.push(published);
        }
        const survivors = await pruneRetainedGenerations({
          cacheDir,
          verified,
          currentGeneration:
            manifestBytes <= CONTROL_UI_RETAINED_ASSET_MAX_BYTES ? manifest.generation : undefined,
          now: Date.now(),
          signal,
        });
        signal?.throwIfAborted();
        generations = survivors;
      })().catch((error: unknown) => {
        preparing = undefined;
        throw error;
      });
      return preparing;
    },
    resolveAsset(assetPath) {
      for (const generation of generations) {
        if (!generation.assetPaths.has(assetPath)) {
          continue;
        }
        return {
          filePath: path.join(generation.directory, assetPath),
          rootPath: generation.directory,
          rootRealPath: generation.realPath,
        };
      }
      return null;
    },
  };
}
