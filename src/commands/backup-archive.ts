import path from "node:path";
import * as tar from "tar";

const WINDOWS_ABSOLUTE_ARCHIVE_PATH_RE = /^[A-Za-z]:[\\/]/;
const MAX_BACKUP_ARCHIVE_ENTRIES = 200_000;
const MAX_BACKUP_MANIFEST_BYTES = 1_000_000;

type ArchiveEntryRecord = {
  raw: string;
  normalized: string;
  type: string;
};

export type BackupManifestAsset = {
  kind: string;
  sourcePath: string;
  archivePath: string;
};

export type BackupManifest = {
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

export type VerifiedBackupArchive = {
  archivePath: string;
  manifest: BackupManifest;
  entryCount: number;
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

function collisionKey(entryPath: string): string {
  return entryPath
    .normalize("NFKC")
    .split("/")
    .map((segment) => segment.trimEnd().replace(/\.+$/u, "").toLowerCase())
    .join("/");
}

function isAllowedArchiveEntryType(type: string): boolean {
  return (
    type === "File" ||
    type === "OldFile" ||
    type === "Directory" ||
    type === "ContiguousFile" ||
    type === "ExtendedHeader" ||
    type === "GlobalExtendedHeader" ||
    type === "NextFileHasLongLinkpath" ||
    type === "NextFileHasLongPath" ||
    type === "OldGnuLongPath" ||
    type === "OldExtendedHeader"
  );
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
  if (parsed.schemaVersion !== 1) {
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
    });
  }

  return {
    schemaVersion: 1,
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

async function scanArchive(params: { archivePath: string }): Promise<{
  entries: ArchiveEntryRecord[];
  manifestRawByPath: Map<string, string>;
}> {
  const entries: ArchiveEntryRecord[] = [];
  const manifestRawByPath = new Map<string, string>();
  let scanError: Error | null = null;
  let manifestTooLargeError: Error | null = null;
  await tar.t({
    file: params.archivePath,
    gzip: true,
    onentry: (entry) => {
      if (scanError) {
        entry.resume();
        return;
      }
      let normalized: string;
      try {
        normalized = normalizeArchivePath(entry.path, "Archive entry");
      } catch (err) {
        scanError = err instanceof Error ? err : new Error(String(err));
        entry.resume();
        return;
      }
      if (entries.length >= MAX_BACKUP_ARCHIVE_ENTRIES) {
        scanError = new Error(
          `Backup archive has too many entries (> ${MAX_BACKUP_ARCHIVE_ENTRIES}).`,
        );
        entry.resume();
        return;
      }
      if (!isAllowedArchiveEntryType(entry.type)) {
        scanError = new Error(
          `Archive contains unsupported entry type ${entry.type}: ${entry.path}`,
        );
        entry.resume();
        return;
      }

      entries.push({
        raw: entry.path,
        normalized,
        type: entry.type,
      });

      if (!isRootManifestEntry(normalized)) {
        entry.resume();
        return;
      }

      const manifestPath = entry.path;
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      entry.on("data", (chunk: Buffer | string) => {
        if (manifestTooLargeError) {
          return;
        }
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.length;
        if (totalBytes > MAX_BACKUP_MANIFEST_BYTES) {
          manifestTooLargeError = new Error(
            `Backup manifest exceeds ${MAX_BACKUP_MANIFEST_BYTES} bytes.`,
          );
          entry.resume();
          return;
        }
        chunks.push(buffer);
      });
      entry.on("end", () => {
        if (manifestTooLargeError) {
          return;
        }
        manifestRawByPath.set(manifestPath, Buffer.concat(chunks).toString("utf8"));
      });
    },
  });
  if (scanError) {
    throw scanError;
  }
  if (manifestTooLargeError) {
    throw manifestTooLargeError;
  }
  return { entries, manifestRawByPath };
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

function findCaseInsensitiveCollision(
  entries: Array<{ normalized: string }>,
): { prior: string; next: string } | undefined {
  const seen = new Map<string, string>();
  for (const entry of entries) {
    const key = collisionKey(entry.normalized);
    const prior = seen.get(key);
    if (prior && prior !== entry.normalized) {
      return { prior, next: entry.normalized };
    }
    seen.set(key, entry.normalized);
  }
  return undefined;
}

export async function readVerifiedBackupArchive(
  archivePath: string,
): Promise<VerifiedBackupArchive> {
  const { entries, manifestRawByPath } = await scanArchive({ archivePath });
  if (entries.length === 0) {
    throw new Error("Backup archive is empty.");
  }
  const normalizedEntrySet = new Set(entries.map((entry) => entry.normalized));

  const manifestMatches = entries.filter((entry) => isRootManifestEntry(entry.normalized));
  if (manifestMatches.length !== 1) {
    throw new Error(`Expected exactly one backup manifest entry, found ${manifestMatches.length}.`);
  }

  const duplicateEntryPath = findDuplicateNormalizedEntryPath(entries);
  if (duplicateEntryPath) {
    throw new Error(`Archive contains duplicate entry path: ${duplicateEntryPath}`);
  }

  const collision = findCaseInsensitiveCollision(entries);
  if (collision) {
    throw new Error(
      `Archive contains paths that collide on common filesystems: ${collision.prior} vs ${collision.next}`,
    );
  }

  const manifestEntryPath = manifestMatches[0]?.raw;
  if (!manifestEntryPath) {
    throw new Error("Backup archive manifest entry could not be resolved.");
  }

  const manifestRaw = manifestRawByPath.get(manifestEntryPath);
  if (!manifestRaw) {
    throw new Error(`Archive is missing manifest entry: ${manifestEntryPath}`);
  }
  const manifest = parseManifest(manifestRaw);
  verifyManifestAgainstEntries(manifest, normalizedEntrySet);

  return {
    archivePath,
    manifest,
    entryCount: entries.length,
  };
}
