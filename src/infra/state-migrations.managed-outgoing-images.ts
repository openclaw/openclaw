// Doctor-only import for retired managed outgoing image metadata JSON files.
import fs from "node:fs";
import path from "node:path";
import { asSafeIntegerInRange } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString as optionalNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import {
  managedImageRecordFromRow,
  managedImageRecordsEqual,
  managedImageRecordToRow,
  MANAGED_OUTGOING_ORIGINALS_SUBDIR,
  type ManagedImageRecord,
  type ManagedImageRecordDatabase,
} from "../gateway/managed-image-record-store.js";
import { getMediaDir } from "../media/store.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { hasErrnoCode } from "./errno.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import type { EngineConnection } from "./sql-connection.js";
import { assertAllowedJsonFields } from "./state-migrations.json-fields.js";
import {
  assertLegacyMigrationSourceUnchanged,
  readLegacyMigrationSourceSnapshotSync,
  type LegacyMigrationSourceSnapshot as LegacySourceSnapshot,
} from "./state-migrations.source-snapshot.js";
import type { LegacyStateDetection, MigrationMessages } from "./state-migrations.types.js";

const LEGACY_RECORD_MAX_BYTES = 1024 * 1024;
const DEFAULT_TRANSIENT_TTL_MS = 15 * 60 * 1000;
const ATTACHMENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DOCTOR_CLAIM_MARKER = ".json.doctor-importing-";
const DOCTOR_CLAIM_SUFFIX_RE =
  /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECORD_KEYS = new Set([
  "attachmentId",
  "sessionKey",
  "agentId",
  "messageId",
  "createdAt",
  "updatedAt",
  "retentionClass",
  "alt",
  "original",
]);
const ORIGINAL_KEYS = new Set(["path", "contentType", "width", "height", "sizeBytes", "filename"]);

type ParsedLegacyRecord = {
  record: ManagedImageRecord;
  snapshot: LegacySourceSnapshot;
  originalPath: string;
};

function sourceNameFromDoctorClaim(name: string): string | null {
  const markerIndex = name.indexOf(DOCTOR_CLAIM_MARKER);
  if (markerIndex < 0) {
    return null;
  }
  const attachmentId = name.slice(0, markerIndex);
  const suffix = name.slice(markerIndex + DOCTOR_CLAIM_MARKER.length);
  return ATTACHMENT_ID_RE.test(attachmentId) && DOCTOR_CLAIM_SUFFIX_RE.test(suffix)
    ? `${attachmentId}.json`
    : null;
}

function isLegacyManagedImageSourceName(name: string): boolean {
  return name.endsWith(".json") || sourceNameFromDoctorClaim(name) !== null;
}

export function detectLegacyManagedOutgoingImages(params: {
  stateDir: string;
  doctorOnlyStateMigrations?: boolean;
}): LegacyStateDetection["managedOutgoingImages"] {
  const sourceDir = path.join(params.stateDir, "media", "outgoing", "records");
  let hasLegacy = false;
  if (params.doctorOnlyStateMigrations === true) {
    try {
      hasLegacy = fs.readdirSync(sourceDir).some(isLegacyManagedImageSourceName);
    } catch (error) {
      // Let migration report an unreadable directory instead of declaring it empty.
      hasLegacy = !hasErrnoCode(error, "ENOENT");
    }
  }
  return { sourceDir, hasLegacy };
}

function recoverInterruptedDoctorClaims(sourceDir: string): void {
  for (const claimName of fs.readdirSync(sourceDir).toSorted()) {
    const sourceName = sourceNameFromDoctorClaim(claimName);
    if (!sourceName) {
      continue;
    }
    const claimPath = path.join(sourceDir, claimName);
    const sourcePath = path.join(sourceDir, sourceName);
    const claimSnapshot = readLegacySourceSnapshot(claimPath);
    if (!fs.existsSync(sourcePath)) {
      fs.renameSync(claimPath, sourcePath);
      continue;
    }
    const sourceSnapshot = readLegacySourceSnapshot(sourcePath);
    if (
      sourceSnapshot.size !== claimSnapshot.size ||
      sourceSnapshot.sha256 !== claimSnapshot.sha256
    ) {
      throw new Error(`interrupted managed image claim conflicts with ${sourcePath}`);
    }
    fs.unlinkSync(claimPath);
  }
}

function readLegacySourceSnapshot(sourcePath: string): LegacySourceSnapshot {
  return readLegacyMigrationSourceSnapshotSync({
    sourcePath,
    label: "managed image",
    maxBytes: LEGACY_RECORD_MAX_BYTES,
  });
}

function nullableNonNegativeInteger(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  return asSafeIntegerInRange(value, { min: 0 });
}

function parseLegacyManagedImageRecord(params: {
  snapshot: LegacySourceSnapshot;
  stateDir: string;
}): ParsedLegacyRecord {
  const raw = JSON.parse(params.snapshot.raw) as unknown;
  if (!isRecord(raw) || !isRecord(raw.original)) {
    throw new Error("legacy managed image record must be an object");
  }
  assertAllowedJsonFields(raw, RECORD_KEYS, "legacy managed image record");
  assertAllowedJsonFields(raw.original, ORIGINAL_KEYS, "legacy managed image record", {
    fieldPrefix: "original.",
  });

  const attachmentId = optionalNonEmptyString(raw.attachmentId);
  const sessionKey = optionalNonEmptyString(raw.sessionKey);
  const agentId = optionalNonEmptyString(raw.agentId);
  const messageId = raw.messageId === null ? null : optionalNonEmptyString(raw.messageId);
  const createdAt = optionalNonEmptyString(raw.createdAt);
  const updatedAt = optionalNonEmptyString(raw.updatedAt);
  const alt = typeof raw.alt === "string" ? raw.alt : undefined;
  const retentionClass = raw.retentionClass;
  const originalPath = optionalNonEmptyString(raw.original.path);
  const contentType = optionalNonEmptyString(raw.original.contentType);
  const width = nullableNonNegativeInteger(raw.original.width);
  const height = nullableNonNegativeInteger(raw.original.height);
  const sizeBytes = nullableNonNegativeInteger(raw.original.sizeBytes);
  const filename =
    raw.original.filename === null ? null : optionalNonEmptyString(raw.original.filename);
  if (
    !attachmentId ||
    !ATTACHMENT_ID_RE.test(attachmentId) ||
    path.basename(params.snapshot.sourcePath) !== `${attachmentId}.json` ||
    !sessionKey ||
    (raw.agentId !== undefined && !agentId) ||
    (raw.messageId !== null && messageId === undefined) ||
    !createdAt ||
    !Number.isFinite(Date.parse(createdAt)) ||
    (raw.updatedAt !== undefined && (!updatedAt || !Number.isFinite(Date.parse(updatedAt)))) ||
    (retentionClass !== undefined &&
      retentionClass !== "transient" &&
      retentionClass !== "history") ||
    alt === undefined ||
    !originalPath ||
    !contentType ||
    width === undefined ||
    height === undefined ||
    sizeBytes === undefined ||
    (raw.original.filename !== null && filename === undefined)
  ) {
    throw new Error(`legacy managed image record is invalid: ${params.snapshot.sourcePath}`);
  }

  const resolvedOriginalPath = path.resolve(originalPath);
  const mediaRoot = path.dirname(path.dirname(path.dirname(resolvedOriginalPath)));
  const allowedMediaRoots = new Set([
    path.resolve(params.stateDir, "media"),
    path.resolve(getMediaDir()),
  ]);
  if (
    !allowedMediaRoots.has(mediaRoot) ||
    path.dirname(resolvedOriginalPath) !== path.join(mediaRoot, MANAGED_OUTGOING_ORIGINALS_SUBDIR)
  ) {
    throw new Error("legacy managed image original is outside managed outgoing storage");
  }
  const mediaId = path.basename(resolvedOriginalPath);
  if (!mediaId || mediaId === "." || mediaId === "..") {
    throw new Error("legacy managed image original has an invalid media id");
  }

  return {
    snapshot: params.snapshot,
    originalPath: resolvedOriginalPath,
    record: {
      attachmentId,
      sessionKey,
      ...(agentId ? { agentId } : {}),
      messageId: messageId ?? null,
      createdAt,
      ...(updatedAt ? { updatedAt } : {}),
      ...(retentionClass === "transient" || retentionClass === "history" ? { retentionClass } : {}),
      alt,
      original: {
        mediaRoot,
        mediaId,
        mediaSubdir: MANAGED_OUTGOING_ORIGINALS_SUBDIR,
        contentType,
        width,
        height,
        sizeBytes,
        filename: filename ?? null,
      },
    },
  };
}

function isExpiredTransient(record: ManagedImageRecord, nowMs: number) {
  const createdAtMs = Date.parse(record.createdAt);
  return record.messageId === null && nowMs - createdAtMs >= DEFAULT_TRANSIENT_TTL_MS;
}

function readManagedImageRow(db: EngineConnection, attachmentId: string) {
  return executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<ManagedImageRecordDatabase>(db)
      .selectFrom("managed_outgoing_image_records")
      .selectAll()
      .where("attachment_id", "=", attachmentId),
  );
}

/** Import, verify, and remove retired record JSON during explicit Doctor repair. */
export function migrateLegacyManagedOutgoingImages(params: {
  detected: LegacyStateDetection["managedOutgoingImages"];
  stateDir: string;
  nowMs?: number;
}): MigrationMessages {
  const changes: string[] = [];
  const warnings: string[] = [];
  if (!params.detected.hasLegacy) {
    return { changes, warnings };
  }

  let parsedRecords: ParsedLegacyRecord[];
  try {
    const sourceDirStat = fs.lstatSync(params.detected.sourceDir);
    if (!sourceDirStat.isDirectory() || sourceDirStat.isSymbolicLink()) {
      throw new Error("legacy managed image records owner is not a regular directory");
    }
    recoverInterruptedDoctorClaims(params.detected.sourceDir);
    parsedRecords = fs
      .readdirSync(params.detected.sourceDir)
      .filter((name) => name.endsWith(".json"))
      .toSorted()
      .map((name) =>
        parseLegacyManagedImageRecord({
          snapshot: readLegacySourceSnapshot(path.join(params.detected.sourceDir, name)),
          stateDir: params.stateDir,
        }),
      );
  } catch (error) {
    warnings.push(`Failed reading legacy managed outgoing image state: ${String(error)}`);
    return { changes, warnings };
  }

  const nowMs = params.nowMs ?? Date.now();
  const discardedIds = new Set<string>();
  try {
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const stateDb = getNodeSqliteKysely<ManagedImageRecordDatabase>(db);
        for (const parsed of parsedRecords) {
          const existing = readManagedImageRow(db, parsed.record.attachmentId);
          if (existing) {
            if (!managedImageRecordsEqual(managedImageRecordFromRow(existing), parsed.record)) {
              throw new Error(
                `legacy managed image record conflicts with shared SQLite state: ${parsed.record.attachmentId}`,
              );
            }
            continue;
          }
          if (isExpiredTransient(parsed.record, nowMs)) {
            discardedIds.add(parsed.record.attachmentId);
            continue;
          }
          executeSqliteQuerySync(
            db,
            stateDb
              .insertInto("managed_outgoing_image_records")
              .values(managedImageRecordToRow(parsed.record)),
          );
        }
      },
      { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } },
    );
  } catch (error) {
    warnings.push(`Failed migrating legacy managed outgoing image state: ${String(error)}`);
    return { changes, warnings };
  }

  // A failed cleanup leaves committed rows and the remaining JSON for an idempotent retry.
  for (const parsed of parsedRecords) {
    const sourcePath = parsed.snapshot.sourcePath;
    try {
      assertLegacyMigrationSourceUnchanged({
        sourcePath,
        snapshot: parsed.snapshot,
        label: "managed image",
        maxBytes: LEGACY_RECORD_MAX_BYTES,
      });
    } catch (error) {
      warnings.push(`Failed verifying legacy managed outgoing image migration: ${String(error)}`);
      return { changes, warnings };
    }
    if (discardedIds.has(parsed.record.attachmentId)) {
      try {
        fs.rmSync(parsed.originalPath, { force: true });
      } catch (error) {
        warnings.push(`Failed deleting expired legacy managed image attachments: ${String(error)}`);
        return { changes, warnings };
      }
    }
    try {
      fs.unlinkSync(sourcePath);
    } catch (error) {
      warnings.push(
        `Migrated managed outgoing images but could not remove legacy JSON: ${String(error)}`,
      );
      return { changes, warnings };
    }
  }
  try {
    fs.rmdirSync(params.detected.sourceDir);
  } catch {
    // Preserve unrelated files and concurrent additions.
  }

  const importedCount = parsedRecords.length - discardedIds.size;
  if (importedCount > 0) {
    changes.push(
      `Migrated ${importedCount} managed outgoing image record(s) → shared SQLite state`,
    );
  }
  if (discardedIds.size > 0) {
    changes.push(
      `Discarded ${discardedIds.size} expired managed outgoing image record(s) and ${discardedIds.size} attachment file(s)`,
    );
  }
  changes.push("Removed legacy managed outgoing image JSON after SQLite verification");
  return { changes, warnings };
}
