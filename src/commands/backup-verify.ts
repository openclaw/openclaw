import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { isBlockedTarEntryType } from "../infra/archive.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveUserPath } from "../utils.js";

const WINDOWS_ABSOLUTE_ARCHIVE_PATH_RE = /^[A-Za-z]:[\\/]/;
const MAX_ARCHIVE_ENTRY_COUNT = 50_000;
const MAX_ARCHIVE_ENTRY_PATH_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1 * 1024 * 1024;

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
  archiveBytes: number;
  totalEntryBytes: number;
  maxEntryBytes: number;
};

export type ArchiveScanTotals = {
  entryCount: number;
  totalPathBytes: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, "");
}

export function normalizeArchivePath(entryPath: string, label: string): string {
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

export function normalizeArchiveRoot(rootName: string): string {
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

export function parseBackupManifest(raw: string): BackupManifest {
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

async function listArchiveEntries(
  archivePath: string,
): Promise<Array<{ path: string; type?: string; size: number }>> {
  const entries: Array<{ path: string; type?: string; size: number }> = [];
  let totals: ArchiveScanTotals = { entryCount: 0, totalPathBytes: 0 };
  let limitError: Error | undefined;
  let parser!: tar.Parser;
  await new Promise<void>((resolve, reject) => {
    let stream: ReturnType<typeof createReadStream> | undefined;
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (error && stream && !stream.destroyed) {
        stream.destroy(error);
      }
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };

    parser = new tar.Parser({
      gzip: true,
      onReadEntry(entry) {
        if (limitError) {
          return;
        }
        try {
          totals = advanceArchiveScanTotals(totals, entry.path);
          entries.push({
            path: entry.path,
            type: entry.type,
            size: Math.max(0, Number.isFinite(entry.size) ? entry.size : 0),
          });
        } catch (error) {
          limitError = error instanceof Error ? error : new Error(String(error));
          parser.abort(limitError);
        }
      },
    });

    parser.on("error", (error) =>
      settle(error instanceof Error ? error : new Error(String(error))),
    );
    parser.on("end", () => settle(limitError));
    stream = createReadStream(archivePath);
    stream.on("error", (error) =>
      settle(error instanceof Error ? error : new Error(String(error))),
    );
    stream.pipe(parser);
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
        let totalBytes = 0;
        let settled = false;
        const fail = (err: Error) => {
          if (settled) {
            return;
          }
          settled = true;
          reject(err);
          entry.removeAllListeners("data");
          entry.resume();
        };

        entry.on("data", (chunk: Buffer | string) => {
          if (settled) {
            return;
          }
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buffer.byteLength;
          if (totalBytes > MAX_MANIFEST_BYTES) {
            fail(new Error(`Backup manifest exceeds maximum size of ${MAX_MANIFEST_BYTES} bytes.`));
            return;
          }
          chunks.push(buffer);
        });
        entry.on("error", (err) => {
          if (settled) {
            return;
          }
          settled = true;
          reject(err);
        });
        entry.on("end", () => {
          if (settled) {
            return;
          }
          settled = true;
          resolve(Buffer.concat(chunks, totalBytes).toString("utf8"));
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

export function advanceArchiveScanTotals(
  totals: ArchiveScanTotals,
  entryPath: string,
): ArchiveScanTotals {
  const entryCount = totals.entryCount + 1;
  if (entryCount > MAX_ARCHIVE_ENTRY_COUNT) {
    throw new Error(`Backup archive exceeds maximum entry count of ${MAX_ARCHIVE_ENTRY_COUNT}.`);
  }

  const totalPathBytes = totals.totalPathBytes + Buffer.byteLength(entryPath, "utf8");
  if (totalPathBytes > MAX_ARCHIVE_ENTRY_PATH_BYTES) {
    throw new Error(
      `Backup archive entry metadata exceeds maximum size of ${MAX_ARCHIVE_ENTRY_PATH_BYTES} bytes.`,
    );
  }

  return { entryCount, totalPathBytes };
}

function requiresExactArchiveEntry(asset: BackupManifestAsset): boolean {
  return asset.kind === "config";
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
    if (!exact && (!nested || requiresExactArchiveEntry(asset))) {
      throw new Error(`Archive is missing payload for manifest asset: ${assetArchivePath}`);
    }
  }
}

function formatResult(result: BackupVerifyResult): string {
  return [
    `Backup archive OK: ${result.archivePath}`,
    `Archive root: ${result.archiveRoot}`,
    `Created at: ${result.createdAt}`,
    `Runtime version: ${result.runtimeVersion}`,
    `Assets verified: ${result.assetCount}`,
    `Archive entries scanned: ${result.entryCount}`,
  ].join("\n");
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

export function findUnsupportedTarSpecialEntry(
  entries: Array<{ path: string; type?: string }>,
): { path: string; type?: string } | undefined {
  return entries.find((entry) => isBlockedTarEntryType(entry.type ?? ""));
}

export async function backupVerifyCommand(
  runtime: RuntimeEnv,
  opts: BackupVerifyOptions,
): Promise<BackupVerifyResult> {
  const archivePath = resolveUserPath(opts.archive);
  const archiveStat = await fs.stat(archivePath);
  const rawEntries = await listArchiveEntries(archivePath);
  if (rawEntries.length === 0) {
    throw new Error("Backup archive is empty.");
  }
  const unsupportedSpecialEntry = findUnsupportedTarSpecialEntry(rawEntries);
  if (unsupportedSpecialEntry) {
    throw new Error(
      `Archive contains unsupported tar special entry (${unsupportedSpecialEntry.type}): ${unsupportedSpecialEntry.path}`,
    );
  }

  const entries = rawEntries.map((entry) => ({
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
  const manifest = parseBackupManifest(manifestRaw);
  verifyManifestAgainstEntries(manifest, normalizedEntrySet);

  const result: BackupVerifyResult = {
    ok: true,
    archivePath,
    archiveRoot: manifest.archiveRoot,
    createdAt: manifest.createdAt,
    runtimeVersion: manifest.runtimeVersion,
    assetCount: manifest.assets.length,
    entryCount: rawEntries.length,
    archiveBytes: archiveStat.size,
    totalEntryBytes: rawEntries.reduce((sum, entry) => sum + entry.size, 0),
    maxEntryBytes: rawEntries.reduce((max, entry) => Math.max(max, entry.size), 0),
  };

  runtime.log(opts.json ? JSON.stringify(result, null, 2) : formatResult(result));
  return result;
}
