// Builds secret-sanitized backup replacements for legacy audit append archives.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CONFIG_AUDIT_SCOPE } from "../config/io.audit.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { SYSTEM_AGENT_AUDIT_SCOPE } from "../system-agent/audit.js";
import { root as createFsSafeRoot } from "./fs-safe.js";
import {
  detectLegacyAuditLogs,
  legacyAuditSourceGenerationKey,
  type LegacyAuditRawCheckpoint,
} from "./state-migrations.audit-checkpoints.js";
import { legacyAuditMoveCandidates } from "./state-migrations.audit-moves.js";
import {
  prepareLegacyAuditRecords,
  serializePreparedAuditRecords,
} from "./state-migrations.audit-records.js";
import {
  findPreviousLegacyAuditRawCheckpoint,
  readLegacyAuditRecoverySourceForBackup,
  readLegacyAuditSourcePrefixSnapshotForBackup,
} from "./state-migrations.audit-recovery.js";
import { inspectLegacyMigrationLinkedMove } from "./state-migrations.no-replace-move.js";

type LegacyAuditBackupCheckpoint = {
  key: string;
  value: LegacyAuditRawCheckpoint;
};

export type LegacyAuditBackupSnapshot = {
  sourcePath: string;
  archiveSourcePath: string;
  skippedSourcePaths: Set<string>;
  checkpoint?: LegacyAuditBackupCheckpoint;
};

export type LegacyAuditBackupCapture = {
  snapshots: LegacyAuditBackupSnapshot[];
  filesystemWitness: string;
  databaseWitness: string;
};

export class LegacyAuditBackupStateChangedError extends Error {
  constructor(message = "Legacy audit state changed while backup was capturing it") {
    super(message);
    this.name = "LegacyAuditBackupStateChangedError";
  }
}

const LEGACY_AUDIT_RAW_CHECKPOINT_SCOPE = "migration.legacy-audit-raw";

export function createLegacyAuditDatabaseWitness(database: DatabaseSync): string {
  const rows = database // sqlite-allow-raw -- Exact snapshot rows define the cross-store witness.
    .prepare(
      `SELECT scope, event_key, payload_json, created_at, sequence
       FROM diagnostic_events
       WHERE (scope IN (?, ?) AND event_key GLOB 'legacy:*') OR scope = ?
       ORDER BY scope, event_key, sequence`,
    )
    .all(CONFIG_AUDIT_SCOPE, SYSTEM_AGENT_AUDIT_SCOPE, LEGACY_AUDIT_RAW_CHECKPOINT_SCOPE);
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

export function legacyAuditBackupCapturesMatch(
  left: LegacyAuditBackupCapture,
  right: LegacyAuditBackupCapture,
): boolean {
  return (
    left.filesystemWitness === right.filesystemWitness &&
    left.databaseWitness === right.databaseWitness
  );
}

/** Replaces live raw checkpoints with metadata for the transformed backup files. */
export function rewriteLegacyAuditBackupCheckpoints(
  database: DatabaseSync,
  snapshots: readonly LegacyAuditBackupSnapshot[],
): void {
  const hasDiagnosticEvents = database // sqlite-allow-raw -- Offline snapshot maintenance boundary.
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get("diagnostic_events") as { ok?: unknown } | undefined;
  if (hasDiagnosticEvents?.ok !== 1) {
    return;
  }
  const scope = LEGACY_AUDIT_RAW_CHECKPOINT_SCOPE;
  database.prepare("DELETE FROM diagnostic_events WHERE scope = ?").run(scope); // sqlite-allow-raw -- Offline snapshot maintenance boundary.
  const insert = database // sqlite-allow-raw -- Offline snapshot maintenance boundary.
    .prepare(
      `INSERT INTO diagnostic_events (
        scope, event_key, payload_json, created_at, sequence
      ) VALUES (?, ?, ?, ?, ?)`,
    );
  let sequence = 1;
  for (const snapshot of snapshots) {
    if (!snapshot.checkpoint) {
      continue;
    }
    insert.run(
      scope,
      snapshot.checkpoint.key,
      JSON.stringify(snapshot.checkpoint.value),
      0,
      sequence,
    );
    sequence += 1;
  }
}

async function createLegacyAuditBackupSnapshotsOnce(params: {
  stateDir: string;
  tempDir: string;
}): Promise<Pick<LegacyAuditBackupCapture, "snapshots" | "filesystemWitness">> {
  const detected = detectLegacyAuditLogs({
    stateDir: params.stateDir,
    doctorOnlyStateMigrations: true,
  });
  if (detected.sources.length === 0) {
    return { snapshots: [], filesystemWitness: createHash("sha256").digest("hex") };
  }
  const root = await createFsSafeRoot(params.stateDir, {
    hardlinks: "reject",
    maxBytes: Number.MAX_SAFE_INTEGER,
    mkdir: false,
    mode: 0o600,
    symlinks: "reject",
  });
  const snapshots: LegacyAuditBackupSnapshot[] = [];
  const filesystemWitness = createHash("sha256");
  for (const [index, source] of detected.sources.entries()) {
    const sourceRelativePath = path.relative(path.resolve(params.stateDir), source.sourcePath);
    let linkedMove: { retained: string; removed: string } | undefined;
    for (const candidate of await legacyAuditMoveCandidates(root, source)) {
      if (
        (candidate.retained === sourceRelativePath || candidate.removed === sourceRelativePath) &&
        (await inspectLegacyMigrationLinkedMove(root, candidate.retained, candidate.removed))
      ) {
        linkedMove = candidate;
        break;
      }
    }
    // Interrupted moves have one logical source. Capture its destination once
    // without unlinking either live name; quarantined destinations stay excluded.
    if (linkedMove && linkedMove.retained !== sourceRelativePath) {
      continue;
    }
    const snapshot =
      source.storage === "raw-archive"
        ? await readLegacyAuditRecoverySourceForBackup(
            root,
            sourceRelativePath,
            linkedMove?.removed,
          )
        : await readLegacyAuditSourcePrefixSnapshotForBackup(
            root,
            sourceRelativePath,
            linkedMove?.removed,
          );
    const sourceGeneration = legacyAuditSourceGenerationKey(sourceRelativePath);
    const previousCheckpoint =
      source.storage === "raw-archive"
        ? findPreviousLegacyAuditRawCheckpoint(params.stateDir, sourceRelativePath)
        : undefined;
    const prepared = prepareLegacyAuditRecords(
      source,
      snapshot.raw,
      sourceGeneration,
      previousCheckpoint?.recordOrdinalBase ?? 0,
    );
    if (!prepared.ok) {
      throw new Error(
        `Legacy ${source.label} append archive cannot be sanitized for backup: ${prepared.warnings.join("; ")}`,
      );
    }
    const sourcePath = path.join(params.tempDir, `legacy-audit-raw-${index}.jsonl`);
    await fs.writeFile(sourcePath, prepared.sanitizedJsonl, { mode: 0o600 });
    let checkpoint: LegacyAuditBackupCheckpoint | undefined;
    if (previousCheckpoint) {
      if (previousCheckpoint.recordCount > prepared.records.length) {
        throw new Error(
          `Legacy ${source.label} append archive is shorter than its durable checkpoint`,
        );
      }
      // Backup rewrites raw bytes to sanitized JSONL. Preserve the source ordinal
      // and rebase the checkpoint hash onto the equivalent transformed prefix.
      const transformedPrefix = Buffer.from(
        serializePreparedAuditRecords(prepared.records.slice(0, previousCheckpoint.recordCount)),
        "utf8",
      );
      const value: LegacyAuditRawCheckpoint = {
        ...previousCheckpoint,
        dev: 0,
        ino: 0,
        mtimeMs: 0,
        size: transformedPrefix.length,
        contentHash: createHash("sha256").update(transformedPrefix).digest("hex"),
      };
      checkpoint = { key: value.generationKey, value };
    }
    const backupSnapshot: LegacyAuditBackupSnapshot = {
      sourcePath,
      archiveSourcePath: source.sourcePath,
      ...(checkpoint ? { checkpoint } : {}),
      skippedSourcePaths: new Set([
        path.resolve(source.sourcePath),
        ...(linkedMove ? [path.resolve(params.stateDir, linkedMove.removed)] : []),
        path.resolve(`${source.sourcePath}.doctor-scrub-progress`),
        path.resolve(`${source.sourcePath}.doctor-scrub-restore`),
        path.resolve(`${source.sourcePath}.doctor-scrub-staging`),
      ]),
    };
    const witnessMetadata = JSON.stringify([
      backupSnapshot.archiveSourcePath,
      snapshot.dev,
      snapshot.ino,
      snapshot.mtimeMs,
      snapshot.size,
      backupSnapshot.checkpoint,
    ]);
    for (const value of [witnessMetadata, prepared.sanitizedJsonl]) {
      filesystemWitness
        .update(String(Buffer.byteLength(value)))
        .update(":")
        .update(value);
    }
    snapshots.push(backupSnapshot);
  }
  return { snapshots, filesystemWitness: filesystemWitness.digest("hex") };
}

export async function createLegacyAuditBackupCapture(params: {
  stateDir: string;
  tempDir: string;
}): Promise<LegacyAuditBackupCapture> {
  let capture: Awaited<ReturnType<typeof createLegacyAuditBackupSnapshotsOnce>>;
  for (let attempt = 0; ; attempt += 1) {
    try {
      capture = await createLegacyAuditBackupSnapshotsOnce(params);
      break;
    } catch (error) {
      if (attempt === 2) {
        throw error;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });
    }
  }
  const databaseWitness =
    withExistingOpenClawStateDatabaseReadOnly(({ db }) => createLegacyAuditDatabaseWitness(db), {
      env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir },
    }) ?? createHash("sha256").digest("hex");
  return { ...capture, databaseWitness };
}
