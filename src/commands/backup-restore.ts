import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { decryptPayloadToArchive } from "../backup/snapshot-store/encryption.js";
import {
  isNixMode,
  parseConfigJson5,
  readConfigFileSnapshot,
  resolveConfigPath,
  resolveOAuthDir,
  resolveStateDir,
} from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveGatewayService } from "../daemon/service.js";
import { extractArchive } from "../infra/archive.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveHomeDir, resolveUserPath } from "../utils.js";
import {
  loadResolvedSnapshotBackup,
  resolveSnapshotStore,
  resolveCurrentInstallationId,
  type BackupSnapshotDeps,
} from "./backup-snapshot-shared.js";
import {
  backupVerifyCommand,
  normalizeArchiveRoot,
  parseBackupManifest,
  type BackupManifest,
  type BackupManifestAsset,
} from "./backup-verify.js";
import { collectWorkspaceDirs, isPathWithin } from "./cleanup-utils.js";

export type BackupRestoreMode = "full-host" | "config-only" | "workspace-only";

export type BackupRestoreOptions = {
  snapshotId?: string;
  archive?: string;
  installationId?: string;
  mode?: BackupRestoreMode;
  json?: boolean;
  forceStop?: boolean;
};

export type BackupRestoreResult = {
  mode: BackupRestoreMode;
  archivePath: string;
  restoredTargets: string[];
};

type RestoreOperation = {
  kind: BackupManifestAsset["kind"];
  sourcePath: string;
  targetPath: string;
};

const RESTORE_EXTRACT_TIMEOUT_MS = 60_000;

function workspacePathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function selectWorkspaceTargets(params: {
  workspaceAssetCount: number;
  manifestWorkspaceDirs: string[];
  restoredWorkspaceDirs: string[];
  currentWorkspaceDirs: string[];
}): string[] | undefined {
  const candidates = [
    params.manifestWorkspaceDirs,
    params.restoredWorkspaceDirs,
    params.currentWorkspaceDirs,
  ];
  for (const dirs of candidates) {
    if (dirs.length === params.workspaceAssetCount) {
      return dirs;
    }
    if (dirs.length === 1 && params.workspaceAssetCount === 1) {
      return dirs;
    }
  }
  return undefined;
}

async function ensureGatewayStopped(
  runtime: RuntimeEnv,
  forceStop: boolean,
  quietOutput: boolean,
): Promise<void> {
  if (isNixMode) {
    return;
  }
  const service = resolveGatewayService();
  let loaded = false;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (error) {
    throw new Error(`Gateway service check failed: ${String(error)}`, {
      cause: error,
    });
  }
  if (!loaded) {
    return;
  }
  if (!forceStop) {
    throw new Error("Gateway service appears to be running. Stop it first or pass --force-stop.");
  }
  try {
    const stdout = quietOutput
      ? new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        })
      : process.stdout;
    await service.stop({ env: process.env, stdout });
  } catch (error) {
    throw new Error(`Gateway stop failed: ${String(error)}`, {
      cause: error,
    });
  }
}

async function prepareRestoreArchive(
  opts: BackupRestoreOptions,
  deps: BackupSnapshotDeps | undefined,
): Promise<{ archivePath: string; tempDir?: string }> {
  if (opts.archive?.trim()) {
    return { archivePath: resolveUserPath(opts.archive) };
  }

  const snapshotId = opts.snapshotId?.trim();
  if (!snapshotId) {
    throw new Error("Pass a local --archive path or a backup snapshot id to restore.");
  }

  const { snapshotStore, stateDir } = await loadResolvedSnapshotBackup({});
  const installationId =
    opts.installationId?.trim() ||
    (await resolveCurrentInstallationId({
      stateDir,
      createIfMissing: false,
    }));
  if (!installationId) {
    throw new Error(
      "No backup installation id found. Restore from --archive or configure backup first.",
    );
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-snapshot-restore-"));
  const filePrefix = randomUUID();
  const envelopePath = path.join(tempDir, `${filePrefix}.envelope.json`);
  const payloadPath = path.join(tempDir, `${filePrefix}.payload.bin`);
  const archivePath = path.join(tempDir, `${filePrefix}.tar.gz`);
  try {
    const storage = await resolveSnapshotStore({ snapshotStore, deps });
    const envelope = await storage.downloadSnapshot({
      installationId,
      snapshotId,
      envelopeOutputPath: envelopePath,
      payloadOutputPath: payloadPath,
    });
    await decryptPayloadToArchive({
      payloadPath,
      archivePath,
      secret: snapshotStore.encryptionKey,
      envelope,
    });
    return { archivePath, tempDir };
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function normalizeRestoreMode(mode?: string): BackupRestoreMode {
  if (!mode?.trim()) {
    return "full-host";
  }
  if (mode === "full-host" || mode === "config-only" || mode === "workspace-only") {
    return mode;
  }
  throw new Error(`Invalid restore mode: ${mode}`);
}

function getAssetExtractPath(extractedRoot: string, asset: BackupManifestAsset): string {
  const parts = asset.archivePath.split("/");
  const rootName = path.basename(extractedRoot);
  const relativeParts = parts[0] === rootName ? parts.slice(1) : parts;
  return path.join(extractedRoot, ...relativeParts);
}

function tryResolveExtractedConfigPath(params: {
  manifest: BackupManifest;
  assetByKind: Map<string, BackupManifestAsset[]>;
  extractedRoot: string;
}): string | undefined {
  const configAsset = params.assetByKind.get("config")?.[0];
  if (configAsset) {
    return getAssetExtractPath(params.extractedRoot, configAsset);
  }

  const stateAsset = params.assetByKind.get("state")?.[0];
  const oldStateDir = params.manifest.paths?.stateDir;
  const oldConfigPath = params.manifest.paths?.configPath;
  if (!stateAsset || !oldStateDir || !oldConfigPath || !isPathWithin(oldConfigPath, oldStateDir)) {
    return undefined;
  }
  const relative = path.relative(oldStateDir, oldConfigPath);
  return path.join(getAssetExtractPath(params.extractedRoot, stateAsset), relative);
}

async function loadRestoredConfig(params: {
  manifest: BackupManifest;
  assetByKind: Map<string, BackupManifestAsset[]>;
  extractedRoot: string;
}): Promise<OpenClawConfig | undefined> {
  const configPath = tryResolveExtractedConfigPath(params);
  if (!configPath) {
    return undefined;
  }
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = parseConfigJson5(raw);
    return parsed.ok ? (parsed.parsed as OpenClawConfig) : undefined;
  } catch {
    return undefined;
  }
}

async function assertTreeContainsNoSymlinks(rootPath: string): Promise<void> {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to restore directory containing symbolic links: ${entryPath}`);
    }
    if (entry.isDirectory()) {
      await assertTreeContainsNoSymlinks(entryPath);
    }
  }
}

async function copySourceToTarget(sourcePath: string, targetPath: string): Promise<void> {
  const stat = await fs.lstat(sourcePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to restore from a symbolic link: ${sourcePath}`);
  }
  if (stat.isDirectory()) {
    await assertTreeContainsNoSymlinks(sourcePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.cp(sourcePath, targetPath, { recursive: true, force: true });
    return;
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(sourcePath, targetPath);
}

async function applyRestoreOperations(
  operations: RestoreOperation[],
  rollbackRoot: string,
): Promise<void> {
  const applied: Array<{ targetPath: string; backupPath?: string }> = [];
  try {
    for (const operation of operations) {
      let backupPath: string | undefined;
      try {
        await fs.access(operation.targetPath);
        backupPath = path.join(
          rollbackRoot,
          `${applied.length}-${path.basename(operation.targetPath) || "target"}`,
        );
        await fs.mkdir(path.dirname(backupPath), { recursive: true });
        await fs.rename(operation.targetPath, backupPath);
      } catch (error) {
        if (!isNotFoundError(error)) {
          throw error;
        }
        backupPath = undefined;
      }
      applied.push({ targetPath: operation.targetPath, backupPath });
      await copySourceToTarget(operation.sourcePath, operation.targetPath);
    }
  } catch (error) {
    for (const appliedOp of applied.toReversed()) {
      await fs.rm(appliedOp.targetPath, { recursive: true, force: true }).catch(() => undefined);
      if (appliedOp.backupPath) {
        await fs.rename(appliedOp.backupPath, appliedOp.targetPath).catch(() => undefined);
      }
    }
    throw error;
  }
}

function isUnsafeRestoreTarget(targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  const root = path.parse(resolved).root;
  if (resolved === root) {
    return true;
  }
  const home = resolveHomeDir();
  return Boolean(home && resolved === path.resolve(home));
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function assertSafeWorkspaceRestoreTarget(params: {
  targetPath: string;
  stateDir: string;
  configPath: string;
  oauthDir: string;
}): void {
  const resolved = path.resolve(params.targetPath);
  if (
    isUnsafeRestoreTarget(resolved) ||
    isPathWithin(resolved, params.stateDir) ||
    resolved === path.resolve(params.configPath) ||
    resolved === path.resolve(params.oauthDir)
  ) {
    throw new Error(`Refusing to restore workspace to an unsafe path: ${resolved}`);
  }
}

export async function buildRestoreOperations(params: {
  mode: BackupRestoreMode;
  manifest: BackupManifest;
  extractedRoot: string;
}): Promise<RestoreOperation[]> {
  const assetByKind = new Map<string, BackupManifestAsset[]>();
  for (const asset of params.manifest.assets) {
    const entries = assetByKind.get(asset.kind) ?? [];
    entries.push(asset);
    assetByKind.set(asset.kind, entries);
  }

  const stateDir = resolveStateDir();
  const configPath = resolveConfigPath();
  const oauthDir = resolveOAuthDir();
  const currentConfigSnapshot = await readConfigFileSnapshot();
  const restoredConfig = await loadRestoredConfig({
    manifest: params.manifest,
    assetByKind,
    extractedRoot: params.extractedRoot,
  });
  const restoredWorkspaceDirs = restoredConfig ? collectWorkspaceDirs(restoredConfig) : [];
  const manifestWorkspaceDirs =
    params.manifest.paths?.workspaceDirs?.map((entry) => resolveUserPath(entry)) ?? [];
  const currentWorkspaceDirs = collectWorkspaceDirs(
    currentConfigSnapshot.valid ? currentConfigSnapshot.config : undefined,
  );

  const operations: RestoreOperation[] = [];
  const stateAsset = assetByKind.get("state")?.[0];
  const configAsset = assetByKind.get("config")?.[0];
  const credentialsAsset = assetByKind.get("credentials")?.[0];
  const workspaceAssets = assetByKind.get("workspace") ?? [];
  const manifestWorkspaceMap = new Map(
    manifestWorkspaceDirs.map((entry) => [workspacePathKey(entry), entry] as const),
  );
  const workspaceAssetSourceKeys = workspaceAssets.map((asset) =>
    workspacePathKey(asset.sourcePath),
  );
  const canMatchWorkspaceTargetsBySourcePath =
    manifestWorkspaceMap.size === workspaceAssets.length &&
    workspaceAssetSourceKeys.every((key) => manifestWorkspaceMap.has(key));

  if (params.mode === "config-only") {
    const configSourcePath =
      (configAsset && getAssetExtractPath(params.extractedRoot, configAsset)) ??
      tryResolveExtractedConfigPath({
        manifest: params.manifest,
        assetByKind,
        extractedRoot: params.extractedRoot,
      });
    if (!configSourcePath) {
      throw new Error("Backup archive does not contain a config asset.");
    }
    return [
      {
        kind: "config",
        sourcePath: configSourcePath,
        targetPath: configPath,
      },
    ];
  }

  if (params.mode === "full-host") {
    if (stateAsset) {
      operations.push({
        kind: "state",
        sourcePath: getAssetExtractPath(params.extractedRoot, stateAsset),
        targetPath: stateDir,
      });
    }

    if (configAsset && !isPathWithin(configPath, stateDir)) {
      operations.push({
        kind: "config",
        sourcePath: getAssetExtractPath(params.extractedRoot, configAsset),
        targetPath: configPath,
      });
    }

    if (credentialsAsset && !isPathWithin(oauthDir, stateDir)) {
      operations.push({
        kind: "credentials",
        sourcePath: getAssetExtractPath(params.extractedRoot, credentialsAsset),
        targetPath: oauthDir,
      });
    }
  }

  if (params.mode === "workspace-only" || params.mode === "full-host") {
    if (workspaceAssets.length > 0) {
      // The manifest records the exact workspace roots that were archived. Prefer it over
      // config-derived values because config parsing may fall back to the default workspace.
      const workspaceTargetsBySourcePath = canMatchWorkspaceTargetsBySourcePath
        ? new Map(
            workspaceAssets.map((asset) => [
              workspacePathKey(asset.sourcePath),
              manifestWorkspaceMap.get(workspacePathKey(asset.sourcePath)),
            ]),
          )
        : undefined;
      const workspaceTargets = workspaceTargetsBySourcePath
        ? undefined
        : selectWorkspaceTargets({
            workspaceAssetCount: workspaceAssets.length,
            manifestWorkspaceDirs,
            restoredWorkspaceDirs,
            currentWorkspaceDirs,
          });
      if (!workspaceTargetsBySourcePath && !workspaceTargets) {
        throw new Error(
          `Workspace restore target mismatch: archive has ${workspaceAssets.length} workspace asset(s), but no compatible restore target set was found.`,
        );
      }
      for (const [index, asset] of workspaceAssets.entries()) {
        const targetPath =
          workspaceTargetsBySourcePath?.get(workspacePathKey(asset.sourcePath)) ??
          workspaceTargets?.[index];
        if (!targetPath) {
          continue;
        }
        assertSafeWorkspaceRestoreTarget({
          targetPath,
          stateDir,
          configPath,
          oauthDir,
        });
        if (params.mode === "full-host" && stateAsset && isPathWithin(targetPath, stateDir)) {
          continue;
        }
        operations.push({
          kind: "workspace",
          sourcePath: getAssetExtractPath(params.extractedRoot, asset),
          targetPath,
        });
      }
    }
  }

  if (operations.length === 0) {
    throw new Error("Backup archive does not contain any assets for the requested restore mode.");
  }
  return operations;
}

export async function backupRestoreCommand(
  runtime: RuntimeEnv,
  opts: BackupRestoreOptions,
  deps?: BackupSnapshotDeps,
): Promise<BackupRestoreResult> {
  await ensureGatewayStopped(runtime, Boolean(opts.forceStop), Boolean(opts.json));

  const mode = normalizeRestoreMode(opts.mode);
  const restoreSource = await prepareRestoreArchive(opts, deps);
  const workingDir =
    restoreSource.tempDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-")));

  try {
    const verifyRuntime: RuntimeEnv = opts.json ? { ...runtime, log: () => {} } : runtime;
    const verified = await backupVerifyCommand(verifyRuntime, {
      archive: restoreSource.archivePath,
      json: false,
    });
    await extractArchive({
      archivePath: restoreSource.archivePath,
      destDir: workingDir,
      kind: "tar",
      tarGzip: true,
      timeoutMs: RESTORE_EXTRACT_TIMEOUT_MS,
    });

    const archiveRoot = normalizeArchiveRoot(verified.archiveRoot);
    const extractedRoot = path.join(workingDir, archiveRoot);
    const manifest = parseBackupManifest(
      await fs.readFile(path.join(extractedRoot, "manifest.json"), "utf8"),
    );
    const operations = await buildRestoreOperations({
      mode,
      manifest,
      extractedRoot,
    });
    const rollbackRoot = path.join(workingDir, "rollback");
    await applyRestoreOperations(operations, rollbackRoot);

    const result: BackupRestoreResult = {
      mode,
      archivePath: restoreSource.archivePath,
      restoredTargets: operations.map((operation) => operation.targetPath),
    };
    runtime.log(
      opts.json
        ? JSON.stringify(result, null, 2)
        : [
            `Restored backup archive ${restoreSource.archivePath}`,
            `Mode: ${mode}`,
            ...result.restoredTargets.map((target) => `- ${target}`),
          ].join("\n"),
    );
    return result;
  } finally {
    if (restoreSource.tempDir) {
      await fs.rm(restoreSource.tempDir, { recursive: true, force: true }).catch(() => undefined);
    } else {
      await fs.rm(workingDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
