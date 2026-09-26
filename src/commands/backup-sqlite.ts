import fs from "node:fs/promises";
import path from "node:path";
import { resolveConfiguredAgentId } from "../agents/agent-scope-config.js";
import { getRuntimeConfig, resolveStateDir } from "../config/config.js";
import { formatErrorMessage } from "../infra/errors.js";
import { assertNotUpdateCapturePath } from "../infra/update-capture-paths.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { createLocalSqliteSnapshotProvider } from "../snapshot/local-repository.js";
import type {
  SnapshotDatabaseManifest,
  SnapshotManifest,
  SnapshotRef,
  SnapshotSummary,
} from "../snapshot/snapshot-provider.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { shortenHomePath } from "../utils.js";
import {
  recordBackupOutcomeBestEffort,
  resolveBackupAgentRoot,
  resolveRequiredBackupPath,
} from "./backup-shared.js";

type BackupSqliteCreateOptions = {
  global?: boolean;
  agent?: string;
  repository?: string;
  json?: boolean;
};

type BackupSqliteRepositoryOptions = {
  repository?: string;
  json?: boolean;
};

type BackupSqliteJsonOptions = {
  json?: boolean;
};

type BackupSqliteVerifyOptions = BackupSqliteJsonOptions & {
  scratch?: string;
};

type BackupSqliteRestoreOptions = BackupSqliteJsonOptions & {
  target?: string;
};

type BackupSqliteListResult = {
  ok: true;
  repositoryPath: string;
  snapshots: SnapshotSummary[];
};

type BackupSqliteSnapshotResult = {
  ok: true;
  snapshotPath: string;
  manifest: SnapshotManifest;
};

type BackupSqliteRestoreResult = BackupSqliteSnapshotResult & {
  targetPath: string;
};

type ResolvedSnapshotDatabase = {
  path: string;
  identity: { role: "global" } | { role: "agent"; agentId: string };
};

const OPENCLAW_SNAPSHOT_READ_OPTIONS = {
  allowedDatabaseRoles: ["global", "agent"],
} as const;

export async function backupSqliteCreateCommand(
  runtime: RuntimeEnv,
  options: BackupSqliteCreateOptions,
): Promise<BackupSqliteSnapshotResult> {
  const repositoryPath = resolveRequiredBackupPath(options.repository, "--repository");
  try {
    const database = await resolveSnapshotDatabase(options);
    const result = await createLocalSqliteSnapshotProvider({ repositoryPath }).create(database);
    const report: BackupSqliteSnapshotResult = {
      ok: true,
      snapshotPath: result.ref.path,
      manifest: result.manifest,
    };
    await recordBackupOutcomeBestEffort(runtime, {
      kind: "sqlite-snapshot",
      archivePath: report.snapshotPath,
      status: "ok",
    });
    if (options.json) {
      writeRuntimeJson(runtime, report);
    } else {
      runtime.log(
        [
          `SQLite snapshot created: ${shortenHomePath(report.snapshotPath)}`,
          `Database: ${formatDatabaseIdentity(report.manifest.database)}`,
          `Size: ${report.manifest.artifact.sizeBytes} bytes`,
        ].join("\n"),
      );
    }
    return report;
  } catch (error) {
    await recordBackupOutcomeBestEffort(runtime, {
      kind: "sqlite-snapshot",
      archivePath: repositoryPath,
      status: "failed",
      error: formatErrorMessage(error),
    });
    throw error;
  }
}

export async function backupSqliteListCommand(
  runtime: RuntimeEnv,
  options: BackupSqliteRepositoryOptions,
): Promise<BackupSqliteListResult> {
  const repositoryPath = resolveRequiredBackupPath(options.repository, "--repository");
  const snapshots = await createLocalSqliteSnapshotProvider({
    repositoryPath,
    ...OPENCLAW_SNAPSHOT_READ_OPTIONS,
  }).list();
  const report: BackupSqliteListResult = {
    ok: true,
    repositoryPath,
    snapshots,
  };
  if (options.json) {
    writeRuntimeJson(runtime, report);
  } else if (snapshots.length === 0) {
    runtime.log(`No SQLite snapshots in ${shortenHomePath(repositoryPath)}.`);
  } else {
    runtime.log(
      snapshots
        .map(
          (snapshot) =>
            `${snapshot.manifest.createdAt}  ${formatDatabaseIdentity(snapshot.manifest.database)}  ${snapshot.manifest.artifact.sizeBytes} bytes  ${shortenHomePath(snapshot.ref.path)}`,
        )
        .join("\n"),
    );
  }
  return report;
}

export async function backupSqliteVerifyCommand(
  runtime: RuntimeEnv,
  snapshot: string,
  options: BackupSqliteVerifyOptions,
): Promise<BackupSqliteSnapshotResult> {
  const resolved = resolveSnapshot(snapshot, options.scratch);
  const verified = await resolved.provider.verify(resolved.ref);
  const report: BackupSqliteSnapshotResult = {
    ok: true,
    snapshotPath: resolved.ref.path,
    manifest: verified.manifest,
  };
  if (options.json) {
    writeRuntimeJson(runtime, report);
  } else {
    runtime.log(
      `SQLite snapshot verified: ${shortenHomePath(report.snapshotPath)} (${formatDatabaseIdentity(report.manifest.database)})`,
    );
  }
  return report;
}

export async function backupSqliteRestoreCommand(
  runtime: RuntimeEnv,
  snapshot: string,
  options: BackupSqliteRestoreOptions,
): Promise<BackupSqliteRestoreResult> {
  const resolved = resolveSnapshot(snapshot);
  const targetPath = resolveRequiredBackupPath(options.target, "--target");
  const restored = await resolved.provider.restoreFresh(resolved.ref, targetPath);
  const report: BackupSqliteRestoreResult = {
    ok: true,
    snapshotPath: resolved.ref.path,
    targetPath,
    manifest: restored.manifest,
  };
  if (options.json) {
    writeRuntimeJson(runtime, report);
  } else {
    runtime.log(
      `SQLite snapshot restored: ${shortenHomePath(report.targetPath)} (${formatDatabaseIdentity(report.manifest.database)})`,
    );
  }
  return report;
}

async function resolveSnapshotDatabase(
  options: BackupSqliteCreateOptions,
): Promise<ResolvedSnapshotDatabase> {
  const rawAgentId = options.agent?.trim();
  if (options.agent !== undefined && !rawAgentId) {
    throw new Error("--agent must not be blank");
  }
  if (options.global === true && rawAgentId) {
    throw new Error("Choose exactly one SQLite snapshot source: --global or --agent <id>.");
  }
  if (options.global !== true && !rawAgentId) {
    throw new Error("Choose a SQLite snapshot source: --global or --agent <id>.");
  }
  if (options.global === true) {
    const selectedPath = resolveOpenClawStateSqlitePath();
    assertNotUpdateCapturePath(selectedPath, resolveStateDir());
    return {
      path: await fs.realpath(selectedPath),
      identity: { role: "global" },
    };
  }
  const config = getRuntimeConfig({ skipPluginValidation: true });
  const agentId = resolveConfiguredAgentId(config, normalizeAgentId(rawAgentId));
  const agentRoot = await resolveBackupAgentRoot(config, agentId);
  assertNotUpdateCapturePath(agentRoot.databasePath, resolveStateDir());
  return {
    path: await fs.realpath(agentRoot.databasePath),
    identity: { role: "agent", agentId },
  };
}

function resolveSnapshot(
  snapshot: string,
  scratch?: string,
): {
  provider: ReturnType<typeof createLocalSqliteSnapshotProvider>;
  ref: SnapshotRef;
} {
  const snapshotPath = resolveRequiredBackupPath(snapshot, "<snapshot>");
  const repositoryPath = path.dirname(snapshotPath);
  const validationRootPath = scratch
    ? resolveRequiredBackupPath(scratch, "--scratch")
    : path.dirname(repositoryPath);
  return {
    provider: createLocalSqliteSnapshotProvider({
      repositoryPath,
      validationRootPath,
      ...OPENCLAW_SNAPSHOT_READ_OPTIONS,
    }),
    ref: { path: snapshotPath },
  };
}

function formatDatabaseIdentity(database: SnapshotDatabaseManifest): string {
  if (database.role === "global") {
    return "global";
  }
  if (database.role === "agent") {
    return `agent:${database.agentId}`;
  }
  return database.id;
}
