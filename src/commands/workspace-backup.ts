import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { detectPreferredCloudDriveTarget } from "../backup/snapshot-store/targets.js";
import {
  readConfigFileSnapshot,
  readConfigFileSnapshotForWrite,
  resolveStateDir,
  writeConfigFile,
} from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { pathExists, resolveUserPath, shortenHomePath } from "../utils.js";
import { encodeAbsolutePathForBackupArchive } from "./backup-shared.js";
import { collectWorkspaceDirs, isPathWithin } from "./cleanup-utils.js";

const WORKSPACE_BACKUP_SCHEMA_VERSION = 1;

type WorkspaceBackupStatusFile = {
  schemaVersion: 1;
  updatedAt: string;
  workspaces: Array<{
    sourcePath: string;
    backupPath: string;
  }>;
};

export type WorkspaceBackupInitOptions = {
  target?: string;
  json?: boolean;
};

export type WorkspaceBackupInitResult = {
  target: string;
  detected?: string;
  updatedConfig: boolean;
};

export type WorkspaceBackupRunOptions = {
  json?: boolean;
};

export type WorkspaceBackupRunResult = {
  target: string;
  updatedAt: string;
  workspaceCount: number;
  workspaces: Array<{
    sourcePath: string;
    backupPath: string;
  }>;
};

export type WorkspaceBackupStatusResult = {
  configured: boolean;
  target?: string;
  detected?: string;
  lastUpdatedAt?: string;
  workspaceCount: number;
};

function resolveBackupConfigTarget(cfg: OpenClawConfig | undefined): string | undefined {
  const configured = cfg?.backup?.target?.trim();
  return configured ? resolveUserPath(configured) : undefined;
}

function workspaceBackupRoot(target: string): string {
  return path.join(target, "workspace");
}

function workspaceMirrorRoot(target: string): string {
  return path.join(workspaceBackupRoot(target), "mirrors");
}

function workspaceStatusPath(target: string): string {
  return path.join(workspaceBackupRoot(target), "status.json");
}

async function readWorkspaceBackupStatus(
  target: string,
): Promise<WorkspaceBackupStatusFile | undefined> {
  try {
    const raw = await fs.readFile(workspaceStatusPath(target), "utf8");
    return JSON.parse(raw) as WorkspaceBackupStatusFile;
  } catch {
    return undefined;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

async function replaceDirectoryAtomically(sourcePath: string, targetPath: string): Promise<void> {
  const rollbackPath = `${targetPath}.${randomUUID()}.bak`;
  const targetExists = await pathExists(targetPath);
  if (targetExists) {
    await fs.rename(targetPath, rollbackPath);
  }
  try {
    await fs.rename(sourcePath, targetPath);
    if (targetExists) {
      await fs.rm(rollbackPath, { recursive: true, force: true });
    }
  } catch (error) {
    if (targetExists) {
      await fs.rename(rollbackPath, targetPath).catch(() => undefined);
    }
    throw error;
  }
}

function assertWorkspaceBackupSafety(
  target: string,
  stateDir: string,
  workspaceDirs: readonly string[],
): void {
  if (isPathWithin(target, stateDir)) {
    throw new Error("backup.target must not be inside the live state directory.");
  }
  for (const workspaceDir of workspaceDirs) {
    if (isPathWithin(target, workspaceDir)) {
      throw new Error(
        `backup.target must not live inside a workspace being mirrored: ${shortenHomePath(workspaceDir)}`,
      );
    }
  }
}

async function resolveWorkspaceBackupState(): Promise<{
  target: string;
  workspaceDirs: string[];
  stateDir: string;
}> {
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid) {
    throw new Error("Config is invalid. Workspace backup commands require a valid config file.");
  }
  const target = resolveBackupConfigTarget(snapshot.config);
  if (!target) {
    throw new Error("backup.target is not configured. Run `openclaw backup setup` first.");
  }
  const workspaceDirs = collectWorkspaceDirs(snapshot.config);
  const stateDir = resolveStateDir();
  assertWorkspaceBackupSafety(target, stateDir, workspaceDirs);
  return {
    target,
    workspaceDirs,
    stateDir,
  };
}

export async function workspaceBackupInitCommand(
  runtime: RuntimeEnv,
  opts: WorkspaceBackupInitOptions,
): Promise<WorkspaceBackupInitResult> {
  const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
  if (!snapshot.valid) {
    throw new Error("Config is invalid. Fix the config before initializing workspace backup.");
  }

  const configuredTarget = resolveBackupConfigTarget(snapshot.resolved);
  const explicitTarget = opts.target?.trim() ? resolveUserPath(opts.target) : undefined;
  const detected =
    !explicitTarget && !configuredTarget ? await detectPreferredCloudDriveTarget() : undefined;
  const target = explicitTarget ?? configuredTarget ?? detected?.targetDir;
  if (!target) {
    throw new Error(
      "Could not detect a cloud drive folder automatically. Pass --target to choose a backup directory.",
    );
  }

  assertWorkspaceBackupSafety(target, resolveStateDir(), collectWorkspaceDirs(snapshot.config));
  await fs.mkdir(target, { recursive: true });
  const nextConfig: OpenClawConfig = {
    ...snapshot.resolved,
    backup: {
      ...snapshot.resolved.backup,
      target,
    },
  };
  const updatedConfig = configuredTarget !== target;
  if (updatedConfig) {
    await writeConfigFile(nextConfig, writeOptions);
  }

  const result: WorkspaceBackupInitResult = {
    target,
    detected: detected?.label,
    updatedConfig,
  };
  runtime.log(
    opts.json
      ? JSON.stringify(result, null, 2)
      : [
          updatedConfig
            ? `Configured workspace backup target: ${shortenHomePath(target)}`
            : `Workspace backup target: ${shortenHomePath(target)}`,
          ...(detected ? [`Detected cloud drive: ${detected.label}`] : []),
        ].join("\n"),
  );
  return result;
}

export async function workspaceBackupRunCommand(
  runtime: RuntimeEnv,
  opts: WorkspaceBackupRunOptions,
): Promise<WorkspaceBackupRunResult> {
  const { target, workspaceDirs, stateDir } = await resolveWorkspaceBackupState();
  const mirrorRoot = workspaceMirrorRoot(target);
  const stagingRoot = path.join(workspaceBackupRoot(target), ".staging");
  await fs.mkdir(mirrorRoot, { recursive: true });
  await fs.mkdir(stagingRoot, { recursive: true });
  assertWorkspaceBackupSafety(target, stateDir, workspaceDirs);

  const mirrored: WorkspaceBackupRunResult["workspaces"] = [];
  const activeSourcePaths = new Set<string>();
  const previousStatus = await readWorkspaceBackupStatus(target);

  for (const workspaceDir of workspaceDirs) {
    if (!(await pathExists(workspaceDir))) {
      continue;
    }
    const relativeDir = encodeAbsolutePathForBackupArchive(workspaceDir);
    const stagedDir = path.join(stagingRoot, `${relativeDir}-${randomUUID()}`);
    const targetDir = path.join(mirrorRoot, relativeDir);
    await fs.mkdir(path.dirname(stagedDir), { recursive: true });
    await fs.cp(workspaceDir, stagedDir, {
      recursive: true,
      force: true,
    });
    await fs.mkdir(path.dirname(targetDir), { recursive: true });
    await replaceDirectoryAtomically(stagedDir, targetDir);
    activeSourcePaths.add(workspaceDir);
    mirrored.push({
      sourcePath: workspaceDir,
      backupPath: targetDir,
    });
  }

  for (const previous of previousStatus?.workspaces ?? []) {
    if (!activeSourcePaths.has(previous.sourcePath)) {
      await fs.rm(previous.backupPath, { recursive: true, force: true });
    }
  }

  const updatedAt = new Date().toISOString();
  const statusFile: WorkspaceBackupStatusFile = {
    schemaVersion: WORKSPACE_BACKUP_SCHEMA_VERSION,
    updatedAt,
    workspaces: mirrored,
  };
  await writeJsonAtomic(workspaceStatusPath(target), statusFile);

  const result: WorkspaceBackupRunResult = {
    target,
    updatedAt,
    workspaceCount: mirrored.length,
    workspaces: mirrored,
  };
  runtime.log(
    opts.json
      ? JSON.stringify(result, null, 2)
      : [
          `Workspace backup updated: ${shortenHomePath(target)}`,
          `Mirrored ${mirrored.length} workspace${mirrored.length === 1 ? "" : "s"}.`,
        ].join("\n"),
  );
  return result;
}

export async function getWorkspaceBackupStatus(): Promise<WorkspaceBackupStatusResult> {
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid) {
    throw new Error("Config is invalid. Workspace backup commands require a valid config file.");
  }
  const configuredTarget = resolveBackupConfigTarget(snapshot.config);
  const statusFile = configuredTarget
    ? await readWorkspaceBackupStatus(configuredTarget)
    : undefined;
  const detectedTarget = !configuredTarget ? await detectPreferredCloudDriveTarget() : undefined;
  return {
    configured: Boolean(configuredTarget),
    target: configuredTarget,
    detected: detectedTarget?.label,
    lastUpdatedAt: statusFile?.updatedAt,
    workspaceCount: statusFile?.workspaces.length ?? 0,
  };
}
