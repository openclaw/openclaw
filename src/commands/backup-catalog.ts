import fs from "node:fs/promises";
import path from "node:path";
import { cancel, isCancel } from "@clack/prompts";
import type { RuntimeEnv } from "../runtime.js";
import { note } from "../terminal/note.js";
import { selectStyled } from "../terminal/prompt-select-styled.js";
import { stylePromptTitle } from "../terminal/prompt-style.js";
import { sanitizeTerminalText } from "../terminal/safe-text.js";
import { pathExists, resolveHomeDir, resolveUserPath, shortenHomePath } from "../utils.js";
import { readVerifiedBackupArchive } from "./backup-archive.js";

export type BackupCatalogEntry = {
  archivePath: string;
  displayArchivePath: string;
  createdAt: string;
  runtimeVersion: string;
  assetCount: number;
  includeWorkspace: boolean;
};

type BackupCatalogSkipped = {
  archivePath: string;
  reason: string;
};

export type BackupCatalogResult = {
  searchRoots: string[];
  archives: BackupCatalogEntry[];
  skipped: BackupCatalogSkipped[];
};

export type BackupListOptions = {
  path?: string;
  json?: boolean;
};

const DEFAULT_BACKUP_DIRNAME = "Backups";

function compareCatalogEntries(left: BackupCatalogEntry, right: BackupCatalogEntry): number {
  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);
  const leftValid = Number.isFinite(leftTime);
  const rightValid = Number.isFinite(rightTime);
  if (leftValid && rightValid && leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  if (leftValid !== rightValid) {
    return leftValid ? -1 : 1;
  }
  return right.archivePath.localeCompare(left.archivePath);
}

async function canonicalizeSearchRoot(targetPath: string): Promise<string> {
  const resolved = path.resolve(targetPath);
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      throw new Error(`Backup search path must be a directory: ${resolved}`);
    }
    return await fs.realpath(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      throw new Error(`Backup search path does not exist: ${resolved}`, { cause: err });
    }
    throw err;
  }
}

async function resolveBackupSearchRoots(searchPath?: string): Promise<string[]> {
  if (searchPath?.trim()) {
    return [await canonicalizeSearchRoot(resolveUserPath(searchPath))];
  }

  const roots = new Set<string>();
  roots.add(await canonicalizeSearchRoot(process.cwd()));
  const homeDir = resolveHomeDir();
  if (homeDir) {
    roots.add(await canonicalizeSearchRoot(homeDir));
    const backupsDir = path.join(homeDir, DEFAULT_BACKUP_DIRNAME);
    if (await pathExists(backupsDir)) {
      roots.add(await canonicalizeSearchRoot(backupsDir));
    }
  }

  return [...roots];
}

async function listCandidateArchives(searchRoot: string): Promise<string[]> {
  const dirents = await fs.readdir(searchRoot, { withFileTypes: true });
  return dirents
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tar.gz"))
    .map((entry) => path.join(searchRoot, entry.name))
    .toSorted((left, right) => right.localeCompare(left));
}

export async function readBackupCatalog(searchPath?: string): Promise<BackupCatalogResult> {
  const searchRoots = await resolveBackupSearchRoots(searchPath);
  const archives: BackupCatalogEntry[] = [];
  const skipped: BackupCatalogSkipped[] = [];

  for (const searchRoot of searchRoots) {
    const candidates = await listCandidateArchives(searchRoot);
    for (const archivePath of candidates) {
      try {
        const verified = await readVerifiedBackupArchive(archivePath);
        archives.push({
          archivePath,
          displayArchivePath: shortenHomePath(archivePath),
          createdAt: verified.manifest.createdAt,
          runtimeVersion: verified.manifest.runtimeVersion,
          assetCount: verified.manifest.assets.length,
          includeWorkspace: verified.manifest.options?.includeWorkspace !== false,
        });
      } catch (err) {
        skipped.push({
          archivePath,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  archives.sort(compareCatalogEntries);
  return {
    searchRoots,
    archives,
    skipped,
  };
}

function formatCatalogSummary(result: BackupCatalogResult): string {
  if (result.archives.length === 0) {
    const roots = result.searchRoots
      .map((root) => sanitizeTerminalText(shortenHomePath(root)))
      .join(", ");
    return `No validated backup archives found in: ${roots}`;
  }

  const lines = [
    `Found ${result.archives.length} validated backup archive${result.archives.length === 1 ? "" : "s"}:`,
  ];
  for (const archive of result.archives) {
    const createdAt = sanitizeTerminalText(archive.createdAt);
    const runtimeVersion = sanitizeTerminalText(archive.runtimeVersion);
    const displayArchivePath = sanitizeTerminalText(archive.displayArchivePath);
    lines.push(
      `- ${createdAt} (${runtimeVersion}, ${archive.assetCount} asset${
        archive.assetCount === 1 ? "" : "s"
      }, workspace ${archive.includeWorkspace ? "included" : "excluded"}): ${displayArchivePath}`,
    );
  }

  if (result.skipped.length > 0) {
    lines.push(
      `Skipped ${result.skipped.length} file${result.skipped.length === 1 ? "" : "s"} that were not valid OpenClaw backup archives.`,
    );
  }

  return lines.join("\n");
}

export async function backupListCommand(
  runtime: RuntimeEnv,
  opts: BackupListOptions = {},
): Promise<BackupCatalogResult> {
  const result = await readBackupCatalog(opts.path);
  runtime.log(opts.json ? JSON.stringify(result, null, 2) : formatCatalogSummary(result));
  return result;
}

export async function chooseBackupArchiveForRestore(params: {
  runtime: RuntimeEnv;
  searchPath?: string;
}): Promise<string> {
  const result = await readBackupCatalog(params.searchPath);
  if (result.archives.length === 0) {
    const roots = result.searchRoots.map((root) => shortenHomePath(root)).join(", ");
    throw new Error(
      `No validated backup archives were found to restore. Searched: ${roots}. Pass an archive path directly or use openclaw backup list <dir>.`,
    );
  }

  if (result.skipped.length > 0) {
    note(
      `Skipped ${result.skipped.length} file${
        result.skipped.length === 1 ? "" : "s"
      } that were not valid OpenClaw backup archives.`,
      "Backup Selection",
    );
  }

  const selectedArchive = await selectStyled<string>({
    message: "Choose a backup version to restore",
    options: result.archives.map((archive) => ({
      value: archive.archivePath,
      label: sanitizeTerminalText(archive.createdAt),
      hint:
        `${sanitizeTerminalText(archive.runtimeVersion)} | ${archive.assetCount} asset${
          archive.assetCount === 1 ? "" : "s"
        } | ` + sanitizeTerminalText(archive.displayArchivePath),
    })),
  });

  if (isCancel(selectedArchive)) {
    cancel(stylePromptTitle("Restore cancelled.") ?? "Restore cancelled.");
    params.runtime.exit(0);
    throw new Error("Restore cancelled.");
  }

  return selectedArchive;
}

export async function resolveLatestBackupArchiveForRestore(params: {
  searchPath?: string;
}): Promise<string> {
  const result = await readBackupCatalog(params.searchPath);
  if (result.archives.length === 0) {
    const roots = result.searchRoots.map((root) => shortenHomePath(root)).join(", ");
    throw new Error(
      `No validated backup archives were found to restore. Searched: ${roots}. Pass an archive path directly or use --choose to pick a backup version.`,
    );
  }

  return result.archives[0].archivePath;
}
