import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace.js";
import {
  clearConfigCache,
  parseConfigJson5,
  readConfigFileSnapshot,
  resolveConfigPath,
  resolveOAuthDir,
  resolveStateDir,
  type OpenClawConfig,
  validateConfigObjectRawWithPlugins,
} from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { pathExists, resolveUserPath, shortenHomePath } from "../utils.js";
import { readVerifiedBackupArchive, type BackupManifestAsset } from "./backup-archive.js";
import type { BackupAssetKind } from "./backup-shared.js";
import { collectWorkspaceDirs, isPathWithin } from "./cleanup-utils.js";

export type BackupRestoreOptions = {
  archive: string;
  dryRun?: boolean;
  force?: boolean;
  includeWorkspace?: boolean;
  json?: boolean;
};

type RestoreTargetType = "file" | "directory";

type BackupRestoreItem = {
  kind: BackupAssetKind;
  sourcePath: string;
  archivePath: string;
  targetPath: string;
  displayTargetPath: string;
  targetType: RestoreTargetType;
};

type StagedBackupRestoreItem = BackupRestoreItem & {
  stagedPath: string;
};

type RestoreTransactionItem = StagedBackupRestoreItem & {
  publishPath: string;
  rollbackPath: string | null;
  published: boolean;
};

type BackupRestoreSkipped = {
  kind: string;
  sourcePath: string;
  displayPath: string;
  reason: string;
};

export type BackupRestoreResult = {
  archivePath: string;
  createdAt: string;
  runtimeVersion: string;
  dryRun: boolean;
  force: boolean;
  includeWorkspace: boolean;
  restored: Array<{
    kind: BackupAssetKind;
    sourcePath: string;
    targetPath: string;
  }>;
  skipped: BackupRestoreSkipped[];
  updatedConfigWorkspacePaths: number;
};

function isKnownBackupKind(value: string): value is BackupAssetKind {
  return (
    value === "state" || value === "config" || value === "credentials" || value === "workspace"
  );
}

function restoreTargetType(kind: BackupAssetKind): RestoreTargetType {
  return kind === "config" ? "file" : "directory";
}

function restorePriority(kind: BackupAssetKind): number {
  switch (kind) {
    case "state":
      return 0;
    case "config":
      return 1;
    case "credentials":
      return 2;
    case "workspace":
      return 3;
  }
}

function normalizeWorkspaceAssetOrder(
  manifestWorkspaceDirs: string[] | undefined,
  assets: BackupManifestAsset[],
): BackupManifestAsset[] {
  if (!manifestWorkspaceDirs || manifestWorkspaceDirs.length === 0) {
    return [...assets].toSorted((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  }

  const indexBySource = new Map(
    manifestWorkspaceDirs.map((workspaceDir, index) => [path.resolve(workspaceDir), index]),
  );
  return [...assets].toSorted((left, right) => {
    const leftIndex = indexBySource.get(path.resolve(left.sourcePath)) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = indexBySource.get(path.resolve(right.sourcePath)) ?? Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }
    return left.sourcePath.localeCompare(right.sourcePath);
  });
}

async function canonicalizePath(targetPath: string): Promise<string> {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function normalizeConfigWorkspacePath(value: string): string {
  return path.resolve(resolveUserPath(value));
}

function buildPathAliases(inputPath: string): string[] {
  const resolved = path.resolve(inputPath);
  const aliases = new Set([resolved]);
  if (resolved.startsWith("/private/var/")) {
    aliases.add(resolved.slice("/private".length));
  } else if (resolved.startsWith("/var/")) {
    aliases.add(path.join("/private", resolved));
  }
  return [...aliases];
}

function rewriteWorkspacePathsInConfig(
  cfg: OpenClawConfig,
  rewrites: Map<string, string>,
): { nextConfig: OpenClawConfig; updatedCount: number } {
  const nextConfig = structuredClone(cfg);
  let updatedCount = 0;

  const rewrite = (workspace: string | undefined): string | undefined => {
    if (!workspace?.trim()) {
      return workspace;
    }
    const mapped = buildPathAliases(normalizeConfigWorkspacePath(workspace))
      .map((candidate) => rewrites.get(candidate))
      .find((candidate): candidate is string => typeof candidate === "string");
    if (!mapped || mapped === workspace) {
      return workspace;
    }
    updatedCount += 1;
    return mapped;
  };

  if (typeof nextConfig.agents?.defaults?.workspace === "string") {
    nextConfig.agents.defaults.workspace = rewrite(nextConfig.agents.defaults.workspace) ?? "";
  }

  if (Array.isArray(nextConfig.agents?.list)) {
    for (const agent of nextConfig.agents.list) {
      if (typeof agent.workspace === "string") {
        agent.workspace = rewrite(agent.workspace) ?? "";
      }
    }
  }

  return { nextConfig, updatedCount };
}

async function buildWorkspaceBaseMapping(
  workspaceAssets: BackupManifestAsset[],
  backupStateDir: string | undefined,
  currentStateDir: string,
): Promise<Map<string, string> | null> {
  if (!backupStateDir) {
    return null;
  }

  const oldBaseDir = path.dirname(await canonicalizePath(backupStateDir));
  const currentBaseDir = path.dirname(path.resolve(currentStateDir));
  const mapping = new Map<string, string>();

  for (const asset of workspaceAssets) {
    const normalizedSourcePath = path.resolve(asset.sourcePath);
    if (!isPathWithin(normalizedSourcePath, oldBaseDir)) {
      return null;
    }
    mapping.set(
      normalizedSourcePath,
      path.resolve(currentBaseDir, path.relative(oldBaseDir, normalizedSourcePath)),
    );
  }

  return mapping;
}

async function resolveWorkspaceRestoreTargets(params: {
  workspaceAssets: BackupManifestAsset[];
  manifestWorkspaceDirs: string[] | undefined;
  backupStateDir: string | undefined;
  currentStateDir: string;
}): Promise<Map<string, string>> {
  if (params.workspaceAssets.length === 0) {
    return new Map();
  }

  const orderedAssets = normalizeWorkspaceAssetOrder(
    params.manifestWorkspaceDirs,
    params.workspaceAssets,
  );
  const currentSnapshot = await readConfigFileSnapshot().catch(() => null);
  const currentConfigExists = await pathExists(path.resolve(resolveConfigPath()));
  const currentWorkspaceDirs =
    currentConfigExists && currentSnapshot?.valid && currentSnapshot.config
      ? collectWorkspaceDirs(currentSnapshot.config)
      : [];

  const currentWorkspaceByPath = new Map(
    currentWorkspaceDirs.map((workspaceDir) => [
      path.resolve(workspaceDir),
      path.resolve(workspaceDir),
    ]),
  );
  const exactCurrentWorkspaceTargets = orderedAssets.map((asset) =>
    currentWorkspaceByPath.get(path.resolve(asset.sourcePath)),
  );
  if (
    exactCurrentWorkspaceTargets.every((targetPath): targetPath is string => Boolean(targetPath))
  ) {
    return new Map(
      orderedAssets.map((asset, index) => [
        path.resolve(asset.sourcePath),
        path.resolve(exactCurrentWorkspaceTargets[index] ?? resolveDefaultAgentWorkspaceDir()),
      ]),
    );
  }

  const remappedFromBackupBase = await buildWorkspaceBaseMapping(
    orderedAssets,
    params.backupStateDir,
    params.currentStateDir,
  );
  if (remappedFromBackupBase) {
    return remappedFromBackupBase;
  }

  if (orderedAssets.length === 1) {
    return new Map([
      [
        path.resolve(orderedAssets[0]?.sourcePath ?? ""),
        path.resolve(resolveDefaultAgentWorkspaceDir()),
      ],
    ]);
  }

  throw new Error(
    `Cannot determine restore targets for ${orderedAssets.length} backed-up workspaces. Configure matching workspaces first or rerun with --no-include-workspace.`,
  );
}

async function buildRestoreItems(params: {
  archivePath: string;
  includeWorkspace: boolean;
}): Promise<{
  items: BackupRestoreItem[];
  skipped: BackupRestoreSkipped[];
  workspaceRewrites: Map<string, string>;
  createdAt: string;
  runtimeVersion: string;
}> {
  const verifiedArchive = await readVerifiedBackupArchive(params.archivePath);
  const manifest = verifiedArchive.manifest;
  const currentStateDir = path.resolve(resolveStateDir());
  const currentConfigPath = path.resolve(resolveConfigPath());
  const currentOauthDir = path.resolve(resolveOAuthDir());

  const workspaceAssets = manifest.assets.filter((asset) => asset.kind === "workspace");
  const workspaceTargets = params.includeWorkspace
    ? await resolveWorkspaceRestoreTargets({
        workspaceAssets,
        manifestWorkspaceDirs: manifest.paths?.workspaceDirs,
        backupStateDir: manifest.paths?.stateDir,
        currentStateDir,
      })
    : new Map<string, string>();

  const items: BackupRestoreItem[] = [];
  const skipped: BackupRestoreSkipped[] = [];
  const workspaceRewrites = new Map<string, string>();

  for (const asset of manifest.assets) {
    if (!isKnownBackupKind(asset.kind)) {
      throw new Error(`Unsupported backup asset kind: ${asset.kind}`);
    }

    if (asset.kind === "workspace" && !params.includeWorkspace) {
      skipped.push({
        kind: asset.kind,
        sourcePath: asset.sourcePath,
        displayPath: shortenHomePath(asset.sourcePath),
        reason: "excluded by --no-include-workspace",
      });
      continue;
    }

    const targetPath =
      asset.kind === "state"
        ? currentStateDir
        : asset.kind === "config"
          ? currentConfigPath
          : asset.kind === "credentials"
            ? currentOauthDir
            : workspaceTargets.get(path.resolve(asset.sourcePath));

    if (!targetPath) {
      throw new Error(`Missing restore target for workspace asset: ${asset.sourcePath}`);
    }

    if (asset.kind === "workspace") {
      for (const alias of buildPathAliases(asset.sourcePath)) {
        workspaceRewrites.set(alias, path.resolve(targetPath));
      }
    }

    items.push({
      kind: asset.kind,
      sourcePath: path.resolve(asset.sourcePath),
      archivePath: asset.archivePath,
      targetPath: path.resolve(targetPath),
      displayTargetPath: shortenHomePath(path.resolve(targetPath)),
      targetType: restoreTargetType(asset.kind),
    });
  }

  items.sort((left, right) => restorePriority(left.kind) - restorePriority(right.kind));
  return {
    items,
    skipped,
    workspaceRewrites,
    createdAt: manifest.createdAt,
    runtimeVersion: manifest.runtimeVersion,
  };
}

async function assertRestoreTargetsReady(params: {
  archivePath: string;
  items: BackupRestoreItem[];
  force: boolean;
}): Promise<void> {
  const archiveRealPath = await canonicalizePath(params.archivePath);
  const conflicts: string[] = [];

  for (const item of params.items) {
    const targetExists = await pathExists(item.targetPath);
    if (targetExists && !params.force) {
      const isEmptyDirectory =
        item.targetType === "directory" &&
        (await fs
          .readdir(item.targetPath)
          .then((entries) => entries.length === 0)
          .catch(() => false));
      if (!isEmptyDirectory) {
        conflicts.push(item.displayTargetPath);
      }
    }
    if (isPathWithin(archiveRealPath, item.targetPath)) {
      throw new Error(
        `Restore archive must not live inside a restore target: ${archiveRealPath} is inside ${item.targetPath}`,
      );
    }
  }

  if (conflicts.length > 0) {
    throw new Error(
      `Restore target already exists. Rerun with --force to replace it: ${conflicts.join(", ")}`,
    );
  }
}

function matchesArchivePath(entryPath: string, assetArchivePath: string): boolean {
  const normalizedEntryPath = entryPath.replace(/\/+$/u, "");
  return (
    normalizedEntryPath === assetArchivePath ||
    normalizedEntryPath.startsWith(`${assetArchivePath}/`)
  );
}

async function extractAssetToStage(params: {
  archivePath: string;
  assetArchivePath: string;
  stageRoot: string;
}): Promise<string> {
  const archivePathParts = params.assetArchivePath.split("/");
  const strip = Math.max(archivePathParts.length - 1, 0);
  await tar.x({
    file: params.archivePath,
    gzip: true,
    cwd: params.stageRoot,
    strip,
    onentry: (entry) => {
      if (entry.type === "Link" || entry.type === "SymbolicLink") {
        throw new Error(`Restore archive contains unsupported link entry: ${entry.path}`);
      }
    },
    filter: (entryPath) => matchesArchivePath(entryPath, params.assetArchivePath),
  });
  return path.join(params.stageRoot, path.posix.basename(params.assetArchivePath));
}

async function copyStagedAsset(params: {
  stagedPath: string;
  targetPath: string;
  targetType: RestoreTargetType;
}): Promise<void> {
  await fs.mkdir(path.dirname(params.targetPath), { recursive: true });
  if (params.targetType === "directory") {
    await fs.cp(params.stagedPath, params.targetPath, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    return;
  }

  await fs.cp(params.stagedPath, params.targetPath, {
    force: false,
    errorOnExist: true,
  });
}

async function applyWorkspaceConfigRewritesToStagedConfig(
  stagedConfigPath: string,
  workspaceRewrites: Map<string, string>,
): Promise<number> {
  if (workspaceRewrites.size === 0) {
    return 0;
  }

  const raw = await fs.readFile(stagedConfigPath, "utf8");
  const parsed = parseConfigJson5(raw);
  if (!parsed.ok) {
    throw new Error(
      `Restored config is invalid JSON5; workspace path rewrites could not be applied: ${parsed.error}`,
    );
  }

  const validated = validateConfigObjectRawWithPlugins(parsed.parsed);
  if (!validated.ok) {
    throw new Error("Restored config is invalid; workspace path rewrites could not be applied.");
  }

  const { nextConfig, updatedCount } = rewriteWorkspacePathsInConfig(
    validated.config,
    workspaceRewrites,
  );
  if (updatedCount === 0) {
    return 0;
  }

  const rewritten = validateConfigObjectRawWithPlugins(nextConfig);
  if (!rewritten.ok) {
    throw new Error("Workspace path rewrites produced an invalid restored config.");
  }

  await fs.writeFile(stagedConfigPath, `${JSON.stringify(rewritten.config, null, 2)}\n`, "utf8");
  return updatedCount;
}

async function stageRestoreItems(params: {
  archivePath: string;
  items: BackupRestoreItem[];
  workspaceRewrites: Map<string, string>;
  stageRoot: string;
}): Promise<{
  stagedItems: StagedBackupRestoreItem[];
  updatedConfigWorkspacePaths: number;
}> {
  const stagedItems: StagedBackupRestoreItem[] = [];

  for (const [index, item] of params.items.entries()) {
    const assetStageRoot = path.join(params.stageRoot, String(index));
    await fs.mkdir(assetStageRoot, { recursive: true });
    const stagedAssetPath = await extractAssetToStage({
      archivePath: params.archivePath,
      assetArchivePath: item.archivePath,
      stageRoot: assetStageRoot,
    });
    if (!(await pathExists(stagedAssetPath))) {
      throw new Error(`Restore staging failed for asset: ${item.archivePath}`);
    }

    stagedItems.push({
      ...item,
      stagedPath: stagedAssetPath,
    });
  }

  const configItem = stagedItems.find((item) => item.kind === "config");
  const updatedConfigWorkspacePaths = configItem
    ? await applyWorkspaceConfigRewritesToStagedConfig(
        configItem.stagedPath,
        params.workspaceRewrites,
      )
    : 0;

  return {
    stagedItems,
    updatedConfigWorkspacePaths,
  };
}

function buildRestoreTempSiblingPath(targetPath: string, prefix: string): string {
  return path.join(
    path.dirname(targetPath),
    `.${prefix}-${path.basename(targetPath)}-${randomUUID()}`,
  );
}

async function publishRestoreItem(params: {
  item: StagedBackupRestoreItem;
  publishPath: string;
}): Promise<void> {
  await copyStagedAsset({
    stagedPath: params.item.stagedPath,
    targetPath: params.publishPath,
    targetType: params.item.targetType,
  });

  if (await pathExists(params.item.targetPath)) {
    throw new Error(
      `Restore target changed during publication and would be overwritten: ${params.item.targetPath}`,
    );
  }

  await fs.rename(params.publishPath, params.item.targetPath);
}

async function rollbackRestorePublication(items: RestoreTransactionItem[]): Promise<void> {
  for (const item of items.toReversed()) {
    await fs.rm(item.publishPath, { recursive: true, force: true }).catch(() => undefined);

    if (item.published) {
      await fs.rm(item.targetPath, { recursive: true, force: true }).catch(() => undefined);
    }

    if (item.rollbackPath) {
      const rollbackPath = item.rollbackPath;
      if (await pathExists(item.targetPath)) {
        await fs.rm(item.targetPath, { recursive: true, force: true }).catch(() => undefined);
      }
      await fs.mkdir(path.dirname(item.targetPath), { recursive: true }).catch(() => undefined);
      await fs.rename(rollbackPath, item.targetPath).catch(async () => {
        if (!(await pathExists(rollbackPath))) {
          return;
        }
        throw new Error(`Failed to roll back restore target: ${item.targetPath}`);
      });
    }
  }
}

async function publishRestorePlan(stagedItems: StagedBackupRestoreItem[]): Promise<void> {
  const transactionItems: RestoreTransactionItem[] = stagedItems.map((item) => ({
    ...item,
    publishPath: buildRestoreTempSiblingPath(item.targetPath, "openclaw-restore"),
    rollbackPath: null,
    published: false,
  }));

  try {
    for (const item of transactionItems) {
      await fs.mkdir(path.dirname(item.targetPath), { recursive: true });

      if (await pathExists(item.targetPath)) {
        item.rollbackPath = buildRestoreTempSiblingPath(
          item.targetPath,
          "openclaw-restore-rollback",
        );
        await fs.rename(item.targetPath, item.rollbackPath);
      }

      await publishRestoreItem({
        item,
        publishPath: item.publishPath,
      });
      item.published = true;
    }
  } catch (err) {
    await rollbackRestorePublication(transactionItems);
    throw err;
  }

  for (const item of transactionItems) {
    if (item.rollbackPath) {
      await fs.rm(item.rollbackPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function formatRestoreSummary(result: BackupRestoreResult): string {
  const lines = [
    result.dryRun
      ? `Planned restore from backup archive: ${result.archivePath}`
      : `Restored backup archive: ${result.archivePath}`,
    `Backup created at: ${result.createdAt}`,
    `Backup runtime version: ${result.runtimeVersion}`,
  ];

  lines.push(
    `${result.dryRun ? "Planned" : "Restored"} ${result.restored.length} path${
      result.restored.length === 1 ? "" : "s"
    }:`,
  );
  for (const entry of result.restored) {
    lines.push(`- ${entry.kind}: ${shortenHomePath(entry.targetPath)}`);
  }

  if (result.skipped.length > 0) {
    lines.push(`Skipped ${result.skipped.length} path${result.skipped.length === 1 ? "" : "s"}:`);
    for (const entry of result.skipped) {
      lines.push(`- ${entry.kind}: ${entry.displayPath} (${entry.reason})`);
    }
  }

  if (result.updatedConfigWorkspacePaths > 0) {
    lines.push(
      `Updated ${result.updatedConfigWorkspacePaths} workspace path${result.updatedConfigWorkspacePaths === 1 ? "" : "s"} in the restored config.`,
    );
  }

  if (result.dryRun) {
    lines.push("Dry run only; no files were written.");
  }

  return lines.join("\n");
}

export async function backupRestoreCommand(
  runtime: RuntimeEnv,
  opts: BackupRestoreOptions,
): Promise<BackupRestoreResult> {
  const archivePath = resolveUserPath(opts.archive);
  const includeWorkspace = opts.includeWorkspace ?? true;
  const restorePlan = await buildRestoreItems({
    archivePath,
    includeWorkspace,
  });

  await assertRestoreTargetsReady({
    archivePath,
    items: restorePlan.items,
    force: Boolean(opts.force),
  });

  const result: BackupRestoreResult = {
    archivePath,
    createdAt: restorePlan.createdAt,
    runtimeVersion: restorePlan.runtimeVersion,
    dryRun: Boolean(opts.dryRun),
    force: Boolean(opts.force),
    includeWorkspace,
    restored: restorePlan.items.map((item) => ({
      kind: item.kind,
      sourcePath: item.sourcePath,
      targetPath: item.targetPath,
    })),
    skipped: restorePlan.skipped,
    updatedConfigWorkspacePaths: 0,
  };

  if (!opts.dryRun) {
    const stageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-"));
    try {
      const stagedRestore = await stageRestoreItems({
        archivePath,
        items: restorePlan.items,
        workspaceRewrites: restorePlan.workspaceRewrites,
        stageRoot,
      });
      await publishRestorePlan(stagedRestore.stagedItems);
      result.updatedConfigWorkspacePaths = stagedRestore.updatedConfigWorkspacePaths;
    } finally {
      await fs.rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    clearConfigCache();
  }

  runtime.log(opts.json ? JSON.stringify(result, null, 2) : formatRestoreSummary(result));
  return result;
}
