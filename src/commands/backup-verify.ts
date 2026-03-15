import { createHash } from "node:crypto";
import path from "node:path";
import * as tar from "tar";
import type { RuntimeEnv } from "../runtime.js";
import { resolveUserPath } from "../utils.js";

const WINDOWS_ABSOLUTE_ARCHIVE_PATH_RE = /^[A-Za-z]:[\\/]/;

type BackupManifestAsset = {
  kind: string;
  sourcePath: string;
  archivePath: string;
  sha256?: string;
};

type BackupManifest = {
  schemaVersion: number;
  createdAt: string;
  archiveRoot: string;
  runtimeVersion: string;
  platform: string;
  nodeVersion: string;
  options?: {
    includeWorkspace?: boolean;
  };
  paths?: {
    stateDir?: string;
    configPath?: string;
    oauthDir?: string;
    workspaceDirs?: string[];
  };
  assets: BackupManifestAsset[];
  skipped?: Array<{
    kind?: string;
    sourcePath?: string;
    reason?: string;
    coveredBy?: string;
  }>;
};

export type BackupVerifyOptions = {
  archive: string;
  json?: boolean;
};

export type BackupVerifyResult = {
  ok: true;
  archivePath: string;
  archiveRoot: string;
  createdAt: string;
  runtimeVersion: string;
  assetCount: number;
  entryCount: number;
  schemaVersion: number;
  checksumsVerified: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, "");
}

function normalizeArchivePath(entryPath: string, label: string): string {
  const trimmed = stripTrailingSlashes(entryPath.trim());
  if (!trimmed) {
    throw new Error(`${label} is empty.`);
  }
  if (trimmed.startsWith("/") || WINDOWS_ABSOLUTE_ARCHIVE_PATH_RE.test(trimmed)) {
    throw new Error(`${label} must be relative: ${entryPath}`);
  }
  if (trimmed.includes("\\")) {
    throw new Error(`${label} must use forward slashes: ${entryPath}`);
  }
  if (trimmed.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error(`${label} contains path traversal segments: ${entryPath}`);
  }

  const normalized = stripTrailingSlashes(path.posix.normalize(trimmed));
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${label} resolves outside the archive root: ${entryPath}`);
  }
  return normalized;
}

function normalizeArchiveRoot(rootName: string): string {
  const normalized = normalizeArchivePath(rootName, "Backup manifest archiveRoot");
  if (normalized.includes("/")) {
    throw new Error(`Backup manifest archiveRoot must be a single path segment: ${rootName}`);
  }
  return normalized;
}

function isArchivePathWithin(child: string, parent: string): boolean {
  const relative = path.posix.relative(parent, child);
  return relative === "" || (!relative.startsWith("../") && relative !== "..");
}

function parseManifest(raw: string): BackupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Backup manifest is not valid JSON: ${String(err)}`, { cause: err });
  }

  if (!isRecord(parsed)) {
    throw new Error("Backup manifest must be an object.");
  }
  if (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) {
    throw new Error(`Unsupported backup manifest schemaVersion: ${String(parsed.schemaVersion)}`);
  }
  if (typeof parsed.archiveRoot !== "string" || !parsed.archiveRoot.trim()) {
    throw new Error("Backup manifest is missing archiveRoot.");
  }
  if (typeof parsed.createdAt !== "string" || !parsed.createdAt.trim()) {
    throw new Error("Backup manifest is missing createdAt.");
  }
  if (!Array.isArray(parsed.assets)) {
    throw new Error("Backup manifest is missing assets.");
  }

  const assets: BackupManifestAsset[] = [];
  for (const asset of parsed.assets) {
    if (!isRecord(asset)) {
      throw new Error("Backup manifest contains a non-object asset.");
    }
    if (typeof asset.kind !== "string" || !asset.kind.trim()) {
      throw new Error("Backup manifest asset is missing kind.");
    }
    if (typeof asset.sourcePath !== "string" || !asset.sourcePath.trim()) {
      throw new Error("Backup manifest asset is missing sourcePath.");
    }
    if (typeof asset.archivePath !== "string" || !asset.archivePath.trim()) {
      throw new Error("Backup manifest asset is missing archivePath.");
    }
    assets.push({
      kind: asset.kind,
      sourcePath: asset.sourcePath,
      archivePath: asset.archivePath,
      sha256: typeof asset.sha256 === "string" && asset.sha256.trim() ? asset.sha256 : undefined,
    });
  }

  return {
    schemaVersion: parsed.schemaVersion,
    archiveRoot: parsed.archiveRoot,
    createdAt: parsed.createdAt,
    runtimeVersion:
      typeof parsed.runtimeVersion === "string" && parsed.runtimeVersion.trim()
        ? parsed.runtimeVersion
        : "unknown",
    platform: typeof parsed.platform === "string" ? parsed.platform : "unknown",
    nodeVersion: typeof parsed.nodeVersion === "string" ? parsed.nodeVersion : "unknown",
    options: isRecord(parsed.options)
      ? { includeWorkspace: parsed.options.includeWorkspace as boolean | undefined }
      : undefined,
    paths: isRecord(parsed.paths)
      ? {
          stateDir: typeof parsed.paths.stateDir === "string" ? parsed.paths.stateDir : undefined,
          configPath:
            typeof parsed.paths.configPath === "string" ? parsed.paths.configPath : undefined,
          oauthDir: typeof parsed.paths.oauthDir === "string" ? parsed.paths.oauthDir : undefined,
          workspaceDirs: Array.isArray(parsed.paths.workspaceDirs)
            ? parsed.paths.workspaceDirs.filter(
                (entry): entry is string => typeof entry === "string",
              )
            : undefined,
        }
      : undefined,
    assets,
    skipped: Array.isArray(parsed.skipped) ? parsed.skipped : undefined,
  };
}

type ArchiveEntry = {
  path: string;
  isDirectory: boolean;
};

async function listArchiveEntries(archivePath: string): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  await tar.t({
    file: archivePath,
    gzip: true,
    onentry: (entry) => {
      entries.push({
        path: entry.path,
        isDirectory: entry.type === "Directory",
      });
    },
  });
  return entries;
}

async function extractManifest(params: {
  archivePath: string;
  manifestEntryPath: string;
}): Promise<string> {
  let manifestContentPromise: Promise<string> | undefined;
  await tar.t({
    file: params.archivePath,
    gzip: true,
    onentry: (entry) => {
      if (entry.path !== params.manifestEntryPath) {
        entry.resume();
        return;
      }

      manifestContentPromise = new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        entry.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        entry.on("error", reject);
        entry.on("end", () => {
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
      });
    },
  });

  if (!manifestContentPromise) {
    throw new Error(`Archive is missing manifest entry: ${params.manifestEntryPath}`);
  }
  return await manifestContentPromise;
}

function isRootManifestEntry(entryPath: string): boolean {
  const parts = entryPath.split("/");
  return parts.length === 2 && parts[0] !== "" && parts[1] === "manifest.json";
}

function verifyManifestAgainstEntries(manifest: BackupManifest, entries: Set<string>): void {
  const archiveRoot = normalizeArchiveRoot(manifest.archiveRoot);
  const manifestEntryPath = path.posix.join(archiveRoot, "manifest.json");
  const normalizedEntries = [...entries];
  const normalizedEntrySet = new Set(normalizedEntries);

  if (!normalizedEntrySet.has(manifestEntryPath)) {
    throw new Error(`Archive is missing manifest entry: ${manifestEntryPath}`);
  }

  for (const entry of normalizedEntries) {
    if (!isArchivePathWithin(entry, archiveRoot)) {
      throw new Error(`Archive entry is outside the declared archive root: ${entry}`);
    }
  }

  const payloadRoot = path.posix.join(archiveRoot, "payload");
  for (const asset of manifest.assets) {
    const assetArchivePath = normalizeArchivePath(asset.archivePath, "Backup manifest asset path");
    if (!isArchivePathWithin(assetArchivePath, payloadRoot)) {
      throw new Error(`Manifest asset path is outside payload root: ${asset.archivePath}`);
    }
    const exact = normalizedEntrySet.has(assetArchivePath);
    const nested = normalizedEntries.some(
      (entry) => entry !== assetArchivePath && isArchivePathWithin(entry, assetArchivePath),
    );
    if (!exact && !nested) {
      throw new Error(`Archive is missing payload for manifest asset: ${assetArchivePath}`);
    }
  }
}

async function hashMultipleEntries(params: {
  archivePath: string;
  entryPaths: Set<string>;
}): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const pending: Promise<void>[] = [];
  await tar.t({
    file: params.archivePath,
    gzip: true,
    onentry: (entry) => {
      if (!params.entryPaths.has(entry.path)) {
        entry.resume();
        return;
      }
      pending.push(
        new Promise<void>((resolve, reject) => {
          const hash = createHash("sha256");
          entry.on("data", (chunk: Buffer | string) => {
            hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          entry.on("error", reject);
          entry.on("end", () => {
            results.set(entry.path, hash.digest("hex"));
            resolve();
          });
        }),
      );
    },
  });
  await Promise.all(pending);
  return results;
}

async function verifyAssetChecksums(params: {
  archivePath: string;
  manifest: BackupManifest;
  archiveEntries: ArchiveEntry[];
}): Promise<void> {
  // Map normalized paths to raw paths, excluding directory entries
  const normalizedToRaw = new Map<string, string>();
  for (const entry of params.archiveEntries) {
    if (entry.isDirectory) {
      continue;
    }
    const normalized = normalizeArchivePath(entry.path, "Archive entry");
    normalizedToRaw.set(normalized, entry.path);
  }

  // Pre-compute which entries each asset needs and collect all raw paths
  type AssetCheck = {
    asset: BackupManifestAsset;
    assetArchivePath: string;
    entries: string[];
  };
  const checks: AssetCheck[] = [];
  const allNeededRawPaths = new Set<string>();

  for (const asset of params.manifest.assets) {
    if (!asset.sha256) {
      if (params.manifest.schemaVersion >= 2) {
        throw new Error(
          `Schema v2 asset is missing required checksum: ${asset.kind} (${asset.sourcePath})`,
        );
      }
      continue;
    }

    const assetArchivePath = normalizeArchivePath(asset.archivePath, "Asset archive path");
    const assetEntries = [...normalizedToRaw.keys()]
      .filter((entry) => entry === assetArchivePath || isArchivePathWithin(entry, assetArchivePath))
      .toSorted();

    if (assetEntries.length === 0) {
      throw new Error(
        `Checksum verification failed: no entries found for asset ${asset.kind} (${asset.sourcePath})`,
      );
    }

    checks.push({ asset, assetArchivePath, entries: assetEntries });
    for (const entry of assetEntries) {
      allNeededRawPaths.add(normalizedToRaw.get(entry)!);
    }
  }

  // Single-pass streaming hash of all needed entries (no content buffering)
  const entryHashes = await hashMultipleEntries({
    archivePath: params.archivePath,
    entryPaths: allNeededRawPaths,
  });

  // Verify checksums using streamed hashes
  for (const { asset, assetArchivePath, entries } of checks) {
    if (entries.length === 1 && entries[0] === assetArchivePath) {
      const rawPath = normalizedToRaw.get(entries[0])!;
      const computed = entryHashes.get(rawPath);
      if (!computed) {
        throw new Error(`Failed to hash entry for asset ${asset.kind} (${asset.sourcePath})`);
      }
      if (computed !== asset.sha256) {
        throw new Error(
          `Checksum mismatch for asset ${asset.kind} (${asset.sourcePath}): expected ${asset.sha256}, got ${computed}`,
        );
      }
    } else {
      const fileHashes: Array<{ relativePath: string; sha256: string }> = [];
      for (const entryPath of entries) {
        const relativePath = path.posix.relative(assetArchivePath, entryPath);
        if (!relativePath) {
          continue;
        }
        const rawPath = normalizedToRaw.get(entryPath)!;
        const sha256 = entryHashes.get(rawPath);
        if (!sha256) {
          throw new Error(`Failed to hash entry for asset ${asset.kind} (${asset.sourcePath})`);
        }
        fileHashes.push({ relativePath, sha256 });
      }

      fileHashes.sort((a, b) =>
        a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
      );
      const hash = createHash("sha256");
      for (const entry of fileHashes) {
        hash.update(`${entry.relativePath}\0${entry.sha256}\n`);
      }
      const computed = hash.digest("hex");
      if (computed !== asset.sha256) {
        throw new Error(
          `Checksum mismatch for asset ${asset.kind} (${asset.sourcePath}): expected ${asset.sha256}, got ${computed}`,
        );
      }
    }
  }
}

function formatResult(result: BackupVerifyResult): string {
  const lines = [
    `Backup archive OK: ${result.archivePath}`,
    `Archive root: ${result.archiveRoot}`,
    `Created at: ${result.createdAt}`,
    `Runtime version: ${result.runtimeVersion}`,
    `Assets verified: ${result.assetCount}`,
    `Archive entries scanned: ${result.entryCount}`,
  ];
  if (result.checksumsVerified) {
    lines.push("Content checksums: verified");
  } else if (result.schemaVersion < 2) {
    lines.push("Content checksums: not present (schema v1 archive)");
  } else {
    lines.push("Content checksums: not present");
  }
  return lines.join("\n");
}

function findDuplicateNormalizedEntryPath(
  entries: Array<{ normalized: string }>,
): string | undefined {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.normalized)) {
      return entry.normalized;
    }
    seen.add(entry.normalized);
  }
  return undefined;
}

export async function backupVerifyCommand(
  runtime: RuntimeEnv,
  opts: BackupVerifyOptions,
): Promise<BackupVerifyResult> {
  const archivePath = resolveUserPath(opts.archive);
  const archiveEntries = await listArchiveEntries(archivePath);
  if (archiveEntries.length === 0) {
    throw new Error("Backup archive is empty.");
  }

  const entries = archiveEntries.map((entry) => ({
    raw: entry.path,
    normalized: normalizeArchivePath(entry.path, "Archive entry"),
  }));
  const normalizedEntrySet = new Set(entries.map((entry) => entry.normalized));

  const manifestMatches = entries.filter((entry) => isRootManifestEntry(entry.normalized));
  if (manifestMatches.length !== 1) {
    throw new Error(`Expected exactly one backup manifest entry, found ${manifestMatches.length}.`);
  }
  const duplicateEntryPath = findDuplicateNormalizedEntryPath(entries);
  if (duplicateEntryPath) {
    throw new Error(`Archive contains duplicate entry path: ${duplicateEntryPath}`);
  }
  const manifestEntryPath = manifestMatches[0]?.raw;
  if (!manifestEntryPath) {
    throw new Error("Backup archive manifest entry could not be resolved.");
  }

  const manifestRaw = await extractManifest({ archivePath, manifestEntryPath });
  const manifest = parseManifest(manifestRaw);
  verifyManifestAgainstEntries(manifest, normalizedEntrySet);

  const hasChecksums = manifest.schemaVersion >= 2 && manifest.assets.some((asset) => asset.sha256);

  if (hasChecksums) {
    await verifyAssetChecksums({
      archivePath,
      manifest,
      archiveEntries,
    });
  }

  const result: BackupVerifyResult = {
    ok: true,
    archivePath,
    archiveRoot: manifest.archiveRoot,
    createdAt: manifest.createdAt,
    runtimeVersion: manifest.runtimeVersion,
    assetCount: manifest.assets.length,
    entryCount: archiveEntries.length,
    schemaVersion: manifest.schemaVersion,
    checksumsVerified: hasChecksums,
  };

  runtime.log(opts.json ? JSON.stringify(result, null, 2) : formatResult(result));
  return result;
}
