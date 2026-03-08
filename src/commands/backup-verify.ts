import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import type { RuntimeEnv } from "../runtime.js";
import { resolveUserPath } from "../utils.js";

type BackupManifestAsset = {
  kind: string;
  sourcePath: string;
  archivePath: string;
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
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseManifest(raw: string): BackupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Backup manifest is not valid JSON: ${String(err)}`);
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

async function listArchiveEntries(archivePath: string): Promise<Set<string>> {
  const entries = new Set<string>();
  await tar.t({
    file: archivePath,
    gzip: true,
    onentry: (entry) => {
      entries.add(entry.path);
    },
  });
  return entries;
}

async function extractManifest(params: {
  archivePath: string;
  manifestEntryPath: string;
}): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-verify-"));
  try {
    await tar.x({
      file: params.archivePath,
      gzip: true,
      cwd: tempDir,
      preservePaths: false,
      entries: [params.manifestEntryPath],
    });
    const manifestPath = path.join(tempDir, params.manifestEntryPath);
    return await fs.readFile(manifestPath, "utf8");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function verifyManifestAgainstEntries(manifest: BackupManifest, entries: Set<string>): void {
  const manifestEntryPath = path.posix.join(manifest.archiveRoot, "manifest.json");
  if (!entries.has(manifestEntryPath)) {
    throw new Error(`Archive is missing manifest entry: ${manifestEntryPath}`);
  }

  for (const entry of entries) {
    if (!entry.startsWith(`${manifest.archiveRoot}/`)) {
      throw new Error(`Archive entry is outside the declared archive root: ${entry}`);
    }
  }

  for (const asset of manifest.assets) {
    if (!asset.archivePath.startsWith(`${manifest.archiveRoot}/payload/`)) {
      throw new Error(`Manifest asset path is outside payload root: ${asset.archivePath}`);
    }
    const exact = entries.has(asset.archivePath);
    const nested = [...entries].some((entry) => entry.startsWith(`${asset.archivePath}/`));
    if (!exact && !nested) {
      throw new Error(`Archive is missing payload for manifest asset: ${asset.archivePath}`);
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

export async function backupVerifyCommand(
  runtime: RuntimeEnv,
  opts: BackupVerifyOptions,
): Promise<BackupVerifyResult> {
  const archivePath = resolveUserPath(opts.archive);
  const entries = await listArchiveEntries(archivePath);
  if (entries.size === 0) {
    throw new Error("Backup archive is empty.");
  }

  const manifestMatches = [...entries].filter((entry) => entry.endsWith("/manifest.json"));
  if (manifestMatches.length !== 1) {
    throw new Error(`Expected exactly one backup manifest entry, found ${manifestMatches.length}.`);
  }
  const manifestEntryPath = manifestMatches[0];
  if (!manifestEntryPath) {
    throw new Error("Backup archive manifest entry could not be resolved.");
  }

  const manifestRaw = await extractManifest({ archivePath, manifestEntryPath });
  const manifest = parseManifest(manifestRaw);
  verifyManifestAgainstEntries(manifest, entries);

  const result: BackupVerifyResult = {
    ok: true,
    archivePath,
    archiveRoot: manifest.archiveRoot,
    createdAt: manifest.createdAt,
    runtimeVersion: manifest.runtimeVersion,
    assetCount: manifest.assets.length,
    entryCount: entries.size,
  };

  runtime.log(opts.json ? JSON.stringify(result, null, 2) : formatResult(result));
  return result;
}
