import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type {
  BackupRunRecord,
  BackupRunLocation,
  BackupRunRetention,
} from "../../packages/gateway-protocol/src/schema/backup.js";
import type { DB as OpenClawStateDatabase } from "./openclaw-state-db.generated.js";

export type {
  BackupRunRecord,
  BackupRunLocation,
  BackupRunRetention,
} from "../../packages/gateway-protocol/src/schema/backup.js";
// Producers must fit multi-part diagnostics before persistence so later parts survive.
export const BACKUP_RUN_ERROR_MAX_LENGTH = 1_200;
export const BACKUP_RUN_WINDOW = 200;
export type BackupRunManifest = Omit<
  BackupRunRecord,
  "id" | "createdAt" | "archivePath" | "status"
>;

export function resolveBackupRunTarget(run: BackupRunRecord): string | undefined {
  // Git's historical target is a commit, while archivePath names its repository.
  return run.kind === "git" ? run.archivePath : run.target;
}

export function resolveBackupRunNamespace(run: BackupRunManifest): string | undefined {
  return run.kind === "archive" ? (run.location?.namespace ?? run.namespace) : undefined;
}

function boundedText(value: string | undefined, maxLength: number): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? truncateUtf16Safe(trimmed, maxLength) : undefined;
}
function isBytes(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function parseLocation(value: unknown): BackupRunLocation | undefined {
  const location = asOptionalRecord(value);
  if (!location) {
    return undefined;
  }
  if (
    typeof location.name !== "string" ||
    typeof location.provider !== "string" ||
    typeof location.locationId !== "string" ||
    typeof location.key !== "string" ||
    typeof location.namespace !== "string" ||
    !isBytes(location.plaintextBytes) ||
    !isBytes(location.storedBytes)
  ) {
    return undefined;
  }
  return {
    name: location.name,
    provider: location.provider,
    locationId: location.locationId,
    key: location.key,
    namespace: location.namespace,
    plaintextBytes: location.plaintextBytes,
    storedBytes: location.storedBytes,
  };
}
function parseRetention(value: unknown): BackupRunRetention | undefined {
  const retention = asOptionalRecord(value);
  if (!retention) {
    return undefined;
  }
  return isBytes(retention.kept) && isBytes(retention.deleted)
    ? { kept: retention.kept, deleted: retention.deleted }
    : undefined;
}

/** One codec for the additive manifest fields; legacy rows need no migration. */
export function parseBackupRun(
  row: OpenClawStateDatabase["backup_runs"],
): BackupRunRecord | undefined {
  if (row.status !== "ok" && row.status !== "failed") {
    return undefined;
  }
  const manifest = safeParseJsonRecord(row.manifest_json);
  if (
    !manifest ||
    (manifest.kind !== "archive" &&
      manifest.kind !== "sqlite-snapshot" &&
      manifest.kind !== "git" &&
      manifest.kind !== "external")
  ) {
    return undefined;
  }
  const location = parseLocation(manifest.location);
  const retention = parseRetention(manifest.retention);
  const namespace =
    location?.namespace ??
    (typeof manifest.namespace === "string" ? manifest.namespace : undefined);
  return {
    id: row.id,
    createdAt: row.created_at,
    archivePath: row.archive_path,
    status: row.status,
    kind: manifest.kind,
    ...(typeof manifest.target === "string" ? { target: manifest.target } : {}),
    ...(namespace === undefined ? {} : { namespace }),
    ...(typeof manifest.error === "string" ? { error: manifest.error } : {}),
    ...(manifest.pushFailed === true ? { pushFailed: true } : {}),
    ...(isBytes(manifest.bytes) ? { bytes: manifest.bytes } : {}),
    ...(location ? { location } : {}),
    ...(retention ? { retention } : {}),
  };
}

export function serializeBackupRunManifest(manifest: BackupRunManifest): string {
  return JSON.stringify({
    kind: manifest.kind,
    target: boundedText(manifest.target, 512),
    namespace: boundedText(resolveBackupRunNamespace(manifest), 128),
    error: boundedText(manifest.error, BACKUP_RUN_ERROR_MAX_LENGTH),
    ...(manifest.pushFailed ? { pushFailed: true } : {}),
    ...(isBytes(manifest.bytes) ? { bytes: manifest.bytes } : {}),
    ...(manifest.location ? { location: manifest.location } : {}),
    ...(manifest.retention ? { retention: manifest.retention } : {}),
  });
}
