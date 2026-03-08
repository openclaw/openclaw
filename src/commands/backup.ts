import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import type { RuntimeEnv } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import {
  buildBackupArchiveBasename,
  buildBackupArchiveRoot,
  buildBackupArchivePath,
  type BackupAsset,
  resolveBackupPlanFromDisk,
} from "./backup-shared.js";
import { isPathWithin } from "./cleanup-utils.js";

export type BackupCreateOptions = {
  output?: string;
  dryRun?: boolean;
  includeWorkspace?: boolean;
  json?: boolean;
  nowMs?: number;
};

type BackupManifestAsset = {
  kind: BackupAsset["kind"];
  sourcePath: string;
  archivePath: string;
};

type BackupManifest = {
  schemaVersion: 1;
  createdAt: string;
  archiveRoot: string;
  runtimeVersion: string;
  platform: NodeJS.Platform;
  nodeVersion: string;
  options: {
    includeWorkspace: boolean;
  };
  paths: {
    stateDir: string;
    configPath: string;
    oauthDir: string;
    workspaceDirs: string[];
  };
  assets: BackupManifestAsset[];
  skipped: Array<{
    kind: string;
    sourcePath: string;
    reason: string;
    coveredBy?: string;
  }>;
};

export type BackupCreateResult = {
  createdAt: string;
  archiveRoot: string;
  archivePath: string;
  dryRun: boolean;
  includeWorkspace: boolean;
  assets: BackupAsset[];
  skipped: Array<{
    kind: string;
    sourcePath: string;
    displayPath: string;
    reason: string;
    coveredBy?: string;
  }>;
};

async function resolveOutputPath(params: { output?: string; nowMs: number }): Promise<string> {
  const basename = buildBackupArchiveBasename(params.nowMs);
  const rawOutput = params.output?.trim();
  if (!rawOutput) {
    return path.resolve(process.cwd(), basename);
  }

  const resolved = resolveUserPath(rawOutput);
  if (rawOutput.endsWith("/") || rawOutput.endsWith("\\")) {
    return path.join(resolved, basename);
  }

  try {
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      return path.join(resolved, basename);
    }
  } catch {
    // Treat as a file path when the target does not exist yet.
  }

  return resolved;
}

async function assertOutputPathReady(outputPath: string): Promise<void> {
  try {
    await fs.access(outputPath);
    throw new Error(`Refusing to overwrite existing backup archive: ${outputPath}`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return;
    }
    throw err;
  }
}

function buildManifest(params: {
  createdAt: string;
  archiveRoot: string;
  includeWorkspace: boolean;
  assets: BackupAsset[];
  skipped: BackupCreateResult["skipped"];
  stateDir: string;
  configPath: string;
  oauthDir: string;
  workspaceDirs: string[];
}): BackupManifest {
  return {
    schemaVersion: 1,
    createdAt: params.createdAt,
    archiveRoot: params.archiveRoot,
    runtimeVersion: resolveRuntimeServiceVersion(),
    platform: process.platform,
    nodeVersion: process.version,
    options: {
      includeWorkspace: params.includeWorkspace,
    },
    paths: {
      stateDir: params.stateDir,
      configPath: params.configPath,
      oauthDir: params.oauthDir,
      workspaceDirs: params.workspaceDirs,
    },
    assets: params.assets.map((asset) => ({
      kind: asset.kind,
      sourcePath: asset.sourcePath,
      archivePath: asset.archivePath,
    })),
    skipped: params.skipped.map((entry) => ({
      kind: entry.kind,
      sourcePath: entry.sourcePath,
      reason: entry.reason,
      coveredBy: entry.coveredBy,
    })),
  };
}

function formatTextSummary(result: BackupCreateResult): string[] {
  const lines = [`Backup archive: ${result.archivePath}`];
  lines.push(`Included ${result.assets.length} path${result.assets.length === 1 ? "" : "s"}:`);
  for (const asset of result.assets) {
    lines.push(`- ${asset.kind}: ${asset.displayPath}`);
  }
  if (result.skipped.length > 0) {
    lines.push(`Skipped ${result.skipped.length} path${result.skipped.length === 1 ? "" : "s"}:`);
    for (const entry of result.skipped) {
      if (entry.reason === "covered" && entry.coveredBy) {
        lines.push(`- ${entry.kind}: ${entry.displayPath} (${entry.reason} by ${entry.coveredBy})`);
      } else {
        lines.push(`- ${entry.kind}: ${entry.displayPath} (${entry.reason})`);
      }
    }
  }
  if (result.dryRun) {
    lines.push("Dry run only; archive was not written.");
  } else {
    lines.push(`Created ${result.archivePath}`);
  }
  return lines;
}

function remapArchiveEntryPath(params: {
  entryPath: string;
  manifestPath: string;
  archiveRoot: string;
}): string {
  const normalizedEntry = path.resolve(params.entryPath);
  if (normalizedEntry === params.manifestPath) {
    return path.posix.join(params.archiveRoot, "manifest.json");
  }
  return buildBackupArchivePath(params.archiveRoot, normalizedEntry);
}

export async function backupCreateCommand(
  runtime: RuntimeEnv,
  opts: BackupCreateOptions = {},
): Promise<BackupCreateResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const archiveRoot = buildBackupArchiveRoot(nowMs);
  const outputPath = await resolveOutputPath({ output: opts.output, nowMs });
  const includeWorkspace = opts.includeWorkspace ?? true;
  const plan = await resolveBackupPlanFromDisk({ includeWorkspace, nowMs });

  if (plan.included.length === 0) {
    throw new Error("No local OpenClaw state was found to back up.");
  }

  const overlappingAsset = plan.included.find((asset) =>
    isPathWithin(outputPath, asset.sourcePath),
  );
  if (overlappingAsset) {
    throw new Error(
      `Backup output must not be written inside a source path: ${outputPath} is inside ${overlappingAsset.sourcePath}`,
    );
  }

  await assertOutputPathReady(outputPath);

  const createdAt = new Date(nowMs).toISOString();
  const result: BackupCreateResult = {
    createdAt,
    archiveRoot,
    archivePath: outputPath,
    dryRun: Boolean(opts.dryRun),
    includeWorkspace,
    assets: plan.included,
    skipped: plan.skipped,
  };

  if (!opts.dryRun) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-"));
    const manifestPath = path.join(tempDir, "manifest.json");
    try {
      const manifest = buildManifest({
        createdAt,
        archiveRoot,
        includeWorkspace,
        assets: result.assets,
        skipped: result.skipped,
        stateDir: plan.stateDir,
        configPath: plan.configPath,
        oauthDir: plan.oauthDir,
        workspaceDirs: plan.workspaceDirs,
      });
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

      await tar.c(
        {
          file: outputPath,
          gzip: true,
          portable: true,
          preservePaths: true,
          onWriteEntry: (entry) => {
            entry.path = remapArchiveEntryPath({
              entryPath: entry.path,
              manifestPath,
              archiveRoot,
            });
          },
        },
        [manifestPath, ...result.assets.map((asset) => asset.sourcePath)],
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  const output = opts.json ? JSON.stringify(result, null, 2) : formatTextSummary(result).join("\n");
  runtime.log(output);
  return result;
}
