import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { asSafeIntegerInRange } from "@openclaw/normalization-core/number-coercion";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import {
  copyPluginInstallRecordMap,
  createPluginInstallRecordMap,
  getPluginInstallRecordMapEntry,
  parsePluginInstallRecordMap,
  serializePluginInstallRecordMap,
  setPluginInstallRecordMapEntry,
} from "../config/plugin-install-record-map.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { parseInstalledPluginIndex } from "../plugins/installed-plugin-index-store.js";
import {
  INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION,
  INSTALLED_PLUGIN_INDEX_VERSION,
  type InstalledPluginIndex,
} from "../plugins/installed-plugin-index.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  LEGACY_DELIVERY_QUEUE_DIRS,
  listLegacyDeliveryQueueFiles,
  listLegacyDeliveryQueueDeliveredMarkers,
  resolveLegacyDeliveryQueuePath,
} from "./delivery-queue-legacy-files.js";
import { deliveryQueueMetadata } from "./delivery-queue-sqlite-bound.js";
import {
  inferDeliveryQueueFailureRetention,
  projectDeliveryQueueTerminalEntry,
} from "./delivery-queue-sqlite.types.js";
import { hashFileDescriptorSync } from "./file-descriptor.js";
import { parseRegistryNpmSpec } from "./npm-registry-spec.js";
import { migrationFileExists } from "./state-migrations.fs.js";
import {
  markLegacyMigrationSourceRemoved,
  readLegacyMigrationReceiptFromDatabase,
  recordLegacyMigrationReceipt,
  resolveLegacyMigrationSourceKey,
} from "./state-migrations.receipts.js";
import {
  assertLegacyMigrationSourceUnchanged,
  readLegacyMigrationSourceSnapshotSync,
  type LegacyMigrationSourceSnapshot,
} from "./state-migrations.source-snapshot.js";
import type { MigrationMessages } from "./state-migrations.types.js";

type SqliteBindRow = Record<string, SQLInputValue>;

function normalizeLegacySqliteInteger(value: number | bigint | null): number | null {
  return typeof value === "bigint" ? Number(value) : value;
}

// Only the file-to-SQLite cutover expires old intent; live queues have no age TTL.
const LEGACY_DELIVERY_QUEUE_MAX_AGE_MS = 72 * 60 * 60_000;

type LegacyArchiveResolution = {
  sourcePath: string;
  targetPath: string;
  action: "archived" | "removed";
};

function hashLegacyArchiveSource(sourcePath: string): string {
  const fd = fs.openSync(sourcePath, "r");
  try {
    return hashFileDescriptorSync(fd).sha256;
  } finally {
    fs.closeSync(fd);
  }
}

function archiveLegacyFileSource(params: {
  sourcePath: string;
  label: string;
  warnings: string[];
}): LegacyArchiveResolution | null {
  try {
    let sourceSha256: string | undefined;
    // Reuse any identical archive, including a numbered collision from an earlier run.
    for (let index = 1; ; index++) {
      const targetPath =
        index === 1 ? `${params.sourcePath}.migrated` : `${params.sourcePath}.migrated.${index}`;
      if (!fs.existsSync(targetPath)) {
        fs.renameSync(params.sourcePath, targetPath);
        return { sourcePath: params.sourcePath, targetPath, action: "archived" };
      }
      // Legacy sources can exceed whole-file allocation limits; hash only collisions.
      sourceSha256 ??= hashLegacyArchiveSource(params.sourcePath);
      if (sourceSha256 === hashLegacyArchiveSource(targetPath)) {
        fs.rmSync(params.sourcePath, { force: true });
        return { sourcePath: params.sourcePath, targetPath, action: "removed" };
      }
    }
  } catch (err) {
    params.warnings.push(`Failed archiving ${params.label} ${params.sourcePath}: ${String(err)}`);
    return null;
  }
}

export function readLegacyInstalledPluginIndex(sourcePath: string): InstalledPluginIndex | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(sourcePath, "utf8")) as unknown;
    const current = parseInstalledPluginIndex(parsed);
    if (current) {
      return current;
    }
    const topLevelInstallRecords = readLegacyTopLevelInstallRecords(parsed);
    const installRecords =
      topLevelInstallRecords === undefined
        ? readLegacyEmbeddedInstallRecords(parsed)
        : topLevelInstallRecords;
    if (!installRecords) {
      return null;
    }
    return parseInstalledPluginIndex({
      version: INSTALLED_PLUGIN_INDEX_VERSION,
      hostContractVersion: "legacy",
      compatRegistryVersion: "legacy",
      migrationVersion: INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION,
      policyHash: "legacy",
      generatedAtMs: 0,
      installRecords,
      plugins: [],
      diagnostics: [],
    });
  } catch {
    return null;
  }
}

function readLegacyTopLevelInstallRecords(
  parsed: unknown,
): Record<string, PluginInstallRecord> | null | undefined {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const legacy = parsed as Record<string, unknown>;
  const key = Object.hasOwn(legacy, "installRecords")
    ? "installRecords"
    : Object.hasOwn(legacy, "records")
      ? "records"
      : undefined;
  return key ? parsePluginInstallRecordMap(legacy[key]) : undefined;
}

function readLegacyEmbeddedInstallRecords(
  parsed: unknown,
): Record<string, PluginInstallRecord> | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const plugins = (parsed as { plugins?: unknown }).plugins;
  if (!Array.isArray(plugins)) {
    return null;
  }
  const records = createPluginInstallRecordMap<unknown>();
  let found = false;
  for (const plugin of plugins) {
    if (!plugin || typeof plugin !== "object" || Array.isArray(plugin)) {
      return null;
    }
    if (!Object.hasOwn(plugin, "installRecord")) {
      continue;
    }
    const pluginId = (plugin as { pluginId?: unknown }).pluginId;
    const installRecord = (plugin as { installRecord?: unknown }).installRecord;
    if (typeof pluginId !== "string" || !pluginId.trim()) {
      return null;
    }
    setPluginInstallRecordMapEntry(records, pluginId, installRecord);
    found = true;
  }
  return found ? parsePluginInstallRecordMap(records) : null;
}

export function legacyInstalledPluginIndexMatches(
  current: InstalledPluginIndex,
  legacy: InstalledPluginIndex,
): boolean {
  return (
    serializePluginInstallRecordMap(current.installRecords) ===
      serializePluginInstallRecordMap(legacy.installRecords) &&
    JSON.stringify(current.plugins) === JSON.stringify(legacy.plugins) &&
    JSON.stringify(current.diagnostics) === JSON.stringify(legacy.diagnostics)
  );
}

function readInstallRecordField(
  record: InstalledPluginIndex["installRecords"][string],
  key: string,
): unknown {
  return (record as Partial<Record<string, unknown>>)[key];
}

function readInstallRecordStringField(
  record: InstalledPluginIndex["installRecords"][string],
  key: string,
): string | undefined {
  const value = readInstallRecordField(record, key);
  return typeof value === "string" ? value : undefined;
}

function legacyInstallRecordHasCurrentResolvedIdentity(params: {
  currentRecord: InstalledPluginIndex["installRecords"][string];
  legacyRecord: InstalledPluginIndex["installRecords"][string];
}): boolean {
  const { currentRecord, legacyRecord } = params;
  const currentResolvedSpec = readInstallRecordStringField(currentRecord, "resolvedSpec");
  const legacySpec = readInstallRecordStringField(legacyRecord, "spec");
  if (legacySpec) {
    return currentResolvedSpec === legacySpec;
  }
  const legacyResolvedSpec = readInstallRecordStringField(legacyRecord, "resolvedSpec");
  return Boolean(legacyResolvedSpec && currentResolvedSpec === legacyResolvedSpec);
}

function readAuthoritativeCurrentNpmIdentity(
  record: InstalledPluginIndex["installRecords"][string],
): { name: string; version: string } | null {
  const resolvedName = readInstallRecordStringField(record, "resolvedName");
  const resolvedVersion = readInstallRecordStringField(record, "resolvedVersion");
  if (resolvedName && resolvedVersion) {
    return { name: resolvedName, version: resolvedVersion };
  }
  const resolvedSpec = readInstallRecordStringField(record, "resolvedSpec");
  const parsed = resolvedSpec ? parseRegistryNpmSpec(resolvedSpec) : null;
  if (parsed?.selectorKind === "exact-version" && parsed.selector) {
    return { name: parsed.name, version: parsed.selector };
  }
  return null;
}

function legacyNpmInstallRecordSupersededByCurrent(params: {
  currentRecord: InstalledPluginIndex["installRecords"][string];
  legacyRecord: InstalledPluginIndex["installRecords"][string];
}): boolean {
  const { currentRecord, legacyRecord } = params;
  if (currentRecord.source !== "npm" || legacyRecord.source !== "npm") {
    return false;
  }
  const legacySpec = readInstallRecordStringField(legacyRecord, "spec");
  const legacyParsedSpec = legacySpec ? parseRegistryNpmSpec(legacySpec) : null;
  if (legacyParsedSpec?.selectorKind !== "exact-version") {
    return false;
  }
  const currentIdentity = readAuthoritativeCurrentNpmIdentity(currentRecord);
  return Boolean(
    currentIdentity &&
    legacyParsedSpec.selector &&
    currentIdentity.name === legacyParsedSpec.name &&
    currentIdentity.version === legacyParsedSpec.selector,
  );
}

function legacyInstallRecordCoveredByCurrent(
  currentRecord: InstalledPluginIndex["installRecords"][string],
  legacyRecord: InstalledPluginIndex["installRecords"][string],
): boolean {
  if (currentRecord.source !== legacyRecord.source) {
    return false;
  }
  if (legacyNpmInstallRecordSupersededByCurrent({ currentRecord, legacyRecord })) {
    return true;
  }
  for (const key of Object.keys(legacyRecord).toSorted()) {
    const currentValue = readInstallRecordField(currentRecord, key);
    if (currentValue === readInstallRecordField(legacyRecord, key)) {
      continue;
    }
    if (
      key === "spec" &&
      legacyInstallRecordHasCurrentResolvedIdentity({ currentRecord, legacyRecord })
    ) {
      continue;
    }
    if ((key === "resolvedAt" || key === "installedAt") && typeof currentValue === "string") {
      continue;
    }
    return false;
  }
  return true;
}

export function mergeLegacyInstalledPluginIndexRecords(
  current: InstalledPluginIndex,
  legacy: InstalledPluginIndex,
): { merged: InstalledPluginIndex; addedCount: number; conflicts: string[] } {
  const installRecords = copyPluginInstallRecordMap(current.installRecords);
  const conflicts: string[] = [];
  let addedCount = 0;
  for (const [pluginId, legacyRecord] of Object.entries(legacy.installRecords)) {
    const currentRecord = getPluginInstallRecordMapEntry(installRecords, pluginId);
    if (!currentRecord) {
      setPluginInstallRecordMapEntry(installRecords, pluginId, legacyRecord);
      addedCount += 1;
      continue;
    }
    if (!legacyInstallRecordCoveredByCurrent(currentRecord, legacyRecord)) {
      conflicts.push(pluginId);
    }
  }
  return {
    merged: {
      ...current,
      installRecords,
    },
    addedCount,
    conflicts,
  };
}

export function archiveLegacyInstalledPluginIndex(params: {
  sourcePath: string;
  changes: string[];
  warnings: string[];
}): void {
  const resolution = archiveLegacyFileSource({
    sourcePath: params.sourcePath,
    label: "plugin install index",
    warnings: params.warnings,
  });
  if (!resolution) {
    return;
  }
  params.changes.push(
    resolution.action === "removed"
      ? `Removed already-archived plugin install index legacy source ${params.sourcePath}`
      : `Archived plugin install index legacy source → ${resolution.targetPath}`,
  );
}

function hardenLegacyImportSource(params: {
  sourcePath: string;
  label: string;
  warnings: string[];
}): boolean {
  try {
    fs.chmodSync(params.sourcePath, 0o600);
    return true;
  } catch (err) {
    params.warnings.push(`Failed securing ${params.label} legacy source: ${String(err)}`);
    return false;
  }
}

export function archiveLegacyImportSource(params: {
  sourcePath: string;
  label: string;
  changes: string[];
  warnings: string[];
}): LegacyArchiveResolution | null {
  if (!hardenLegacyImportSource(params)) {
    return null;
  }
  const resolution = archiveLegacyFileSource({
    sourcePath: params.sourcePath,
    label: `${params.label} legacy source`,
    warnings: params.warnings,
  });
  if (!resolution) {
    return null;
  }
  if (resolution.action === "archived") {
    try {
      fs.chmodSync(resolution.targetPath, 0o600);
    } catch (err) {
      params.warnings.push(
        `Failed securing archived ${params.label} legacy source: ${String(err)}`,
      );
    }
  }
  params.changes.push(
    resolution.action === "removed"
      ? `Removed already-archived ${params.label} legacy source ${params.sourcePath}`
      : `Archived ${params.label} legacy source → ${resolution.targetPath}`,
  );
  return resolution;
}

function buildLegacyDeliveryQueueRow(params: {
  queueName: string;
  id: string;
  status: "pending" | "failed";
  entry: Record<string, unknown>;
  now: number;
}): (SqliteBindRow & { id: string }) | null {
  const originalEnqueuedAt =
    asSafeIntegerInRange(params.entry.enqueuedAt, { min: 0 }) ?? params.now;
  const retryCount = asSafeIntegerInRange(params.entry.retryCount, { min: 0 }) ?? 0;
  const lastAttemptAt = asSafeIntegerInRange(params.entry.lastAttemptAt, { min: 0 });
  const platformSendStartedAt = asSafeIntegerInRange(params.entry.platformSendStartedAt, {
    min: 0,
  });
  const failed = params.status === "failed";
  const retention = failed
    ? inferDeliveryQueueFailureRetention(params.entry, params.id, params.queueName)
    : undefined;
  if (failed && !retention) {
    return null;
  }
  const failedAt = failed
    ? (asSafeIntegerInRange(params.entry.failedAt, { min: 0 }) ??
      lastAttemptAt ??
      originalEnqueuedAt)
    : null;
  const enqueuedAt = failedAt ?? originalEnqueuedAt;
  const meta = failed ? undefined : deliveryQueueMetadata(params.queueName, params.entry);
  const retainedEntry: Record<string, unknown> = {
    ...params.entry,
    id: params.id,
    enqueuedAt,
    retryCount,
  };
  if (lastAttemptAt === undefined) {
    delete retainedEntry.lastAttemptAt;
  } else {
    retainedEntry.lastAttemptAt = lastAttemptAt;
  }
  if (platformSendStartedAt === undefined) {
    delete retainedEntry.platformSendStartedAt;
  } else {
    retainedEntry.platformSendStartedAt = platformSendStartedAt;
  }
  const failedEntry = failed
    ? projectDeliveryQueueTerminalEntry(
        { id: params.id, retryCount },
        enqueuedAt,
        "failed",
        retention,
      )
    : undefined;
  return {
    queue_name: params.queueName,
    id: params.id,
    status: params.status,
    entry_kind: meta?.entryKind ?? null,
    session_key: meta?.sessionKey ?? null,
    channel: meta?.channel ?? null,
    target: meta?.target ?? null,
    account_id: meta?.accountId ?? null,
    retry_count: retryCount,
    last_attempt_at: !failed ? (lastAttemptAt ?? null) : null,
    last_error:
      !failed && typeof params.entry.lastError === "string" ? params.entry.lastError : null,
    recovery_state: failed
      ? (failedEntry?.recoveryState ?? null)
      : typeof params.entry.recoveryState === "string"
        ? params.entry.recoveryState
        : null,
    platform_send_started_at: !failed ? (platformSendStartedAt ?? null) : null,
    entry_json: JSON.stringify(failedEntry ?? retainedEntry),
    enqueued_at: enqueuedAt,
    updated_at: params.now,
    failed_at: failedAt,
  };
}

function legacyDeliveryQueueRowsMatch(
  existing: Record<string, unknown>,
  incoming: SqliteBindRow,
): boolean {
  return [
    "status",
    "entry_kind",
    "session_key",
    "channel",
    "target",
    "account_id",
    "retry_count",
    "last_attempt_at",
    "last_error",
    "recovery_state",
    "platform_send_started_at",
    "entry_json",
    "enqueued_at",
    "failed_at",
  ].every((column) => {
    const left = existing[column];
    const right = incoming[column];
    if (typeof left === "bigint" || typeof right === "bigint") {
      return (
        normalizeLegacySqliteInteger(left as number | bigint | null) ===
        normalizeLegacySqliteInteger(right as number | bigint | null)
      );
    }
    return left === right;
  });
}

/** Never recursively remove a queue directory containing retained archives or unknown files. */
function removeEmptyLegacyDeliveryQueueDirs(queueDir: string): void {
  for (const dir of [path.join(queueDir, "failed"), queueDir]) {
    try {
      fs.rmdirSync(dir);
    } catch (error) {
      if (
        !["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")
      ) {
        throw error;
      }
    }
  }
}

type LegacyDeliveryQueueImport = {
  snapshot: LegacyMigrationSourceSnapshot;
  sourceKey: string;
  row: (SqliteBindRow & { id: string }) | null;
  reason?: string;
  mediaPaths: string[];
  mediaBackups?: unknown;
};

export async function migrateLegacyDeliveryQueues(params: {
  stateDir: string;
}): Promise<MigrationMessages> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const env = { ...process.env, OPENCLAW_STATE_DIR: params.stateDir };
  // Both namespaces use the same inclusive cutoff, not the latest retry or file mtime.
  const now = Date.now();
  let refused = false;
  for (const queue of LEGACY_DELIVERY_QUEUE_DIRS) {
    const queueDir = resolveLegacyDeliveryQueuePath(params.stateDir, queue.dirName);
    const files = listLegacyDeliveryQueueFiles(queueDir);
    const markerPaths = listLegacyDeliveryQueueDeliveredMarkers(queueDir);
    if (files.length === 0 && markerPaths.length === 0) {
      continue;
    }
    const imports: LegacyDeliveryQueueImport[] = [];
    const sourceIds = new Map<string, string>();
    const unresolvedPendingIds = new Set<string | undefined>();
    const conflicts: string[] = [];
    let imported = 0;
    const deliveredNames = new Set(markerPaths.map((file) => path.basename(file, ".delivered")));
    const deliveredIds = new Set(deliveredNames);
    const markerIds = new Map([...deliveredNames].map((name) => [name, new Set([name])]));
    // Snapshot markers before any retirement. A leftover .json twin is already delivered.
    for (const file of [
      ...files,
      ...markerPaths.map((sourcePath) => ({ sourcePath, status: "delivered" as const })),
    ]) {
      try {
        const snapshot = readLegacyMigrationSourceSnapshotSync({
          sourcePath: file.sourcePath,
          label: queue.label,
        });
        let reason: string | undefined;
        let mediaPaths: string[] = [];
        let row: (SqliteBindRow & { id: string }) | null = null;
        if (file.status === "delivered") {
          reason = "delivered";
          try {
            const id = asNullableRecord(JSON.parse(snapshot.raw))?.id;
            if (typeof id === "string" && id) {
              deliveredIds.add(id);
              markerIds.get(path.basename(file.sourcePath, ".delivered"))?.add(id);
            }
          } catch {
            // The delivered filename remains terminal evidence for opaque older markers.
          }
        } else {
          const parsed: unknown = JSON.parse(snapshot.raw);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("expected a queue entry object");
          }
          const entry = parsed as Record<string, unknown>;
          const id =
            typeof entry.id === "string" ? entry.id : path.basename(file.sourcePath, ".json");
          if (!id) {
            throw new Error("missing queue entry id");
          }
          const enqueuedAt = asSafeIntegerInRange(entry.enqueuedAt, { min: 0 });
          if (file.status === "pending") {
            sourceIds.set(file.sourcePath, id);
            if (
              deliveredNames.has(path.basename(file.sourcePath, ".json")) ||
              deliveredNames.has(id)
            ) {
              reason = "delivered";
            } else if (enqueuedAt === undefined || enqueuedAt > now) {
              reason = "unverified enqueue time";
            } else if (now - enqueuedAt >= LEGACY_DELIVERY_QUEUE_MAX_AGE_MS) {
              reason = "at least 72 hours old";
            }
          }
          if ((reason && reason !== "delivered") || file.status === "failed") {
            mediaPaths = (
              await import("./state-migrations.delivery-queue-media.js")
            ).resolveLegacyDeliveryQueueMediaPaths(entry, params.stateDir);
          }
          if (!reason) {
            row = buildLegacyDeliveryQueueRow({
              queueName: queue.queueName,
              id,
              status: file.status,
              entry,
              now,
            });
          }
        }
        imports.push({
          snapshot,
          sourceKey: resolveLegacyMigrationSourceKey(
            "delivery-queue",
            file.sourcePath,
            snapshot.sha256,
          ),
          row,
          reason,
          mediaPaths,
        });
      } catch (error) {
        if (file.status === "pending") {
          unresolvedPendingIds.add(sourceIds.get(file.sourcePath));
        }
        refused = true;
        warnings.push(
          `Left malformed ${queue.label} source ${file.sourcePath} in place: ${String(error)}`,
        );
      }
    }
    // A marker settles a queue identity, not merely one filename. Resolve aliases
    // before inserting anything so a second legacy copy cannot replay the same ID.
    for (const [sourcePath, id] of sourceIds) {
      if (deliveredNames.has(path.basename(sourcePath, ".json"))) {
        deliveredIds.add(id);
        markerIds.get(path.basename(sourcePath, ".json"))?.add(id);
      }
    }
    for (const item of imports) {
      const id = sourceIds.get(item.snapshot.sourcePath);
      if (id !== undefined && deliveredIds.has(id)) {
        item.row = null;
        item.reason = "delivered";
        item.mediaPaths = [];
      }
    }
    const committed: LegacyDeliveryQueueImport[] = [];
    try {
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          const insert = db.prepare(
            `INSERT INTO delivery_queue_entries (queue_name, id, status, entry_kind, session_key, channel, target, account_id, retry_count, last_attempt_at, last_error, recovery_state, platform_send_started_at, entry_json, enqueued_at, updated_at, failed_at) VALUES (@queue_name, @id, @status, @entry_kind, @session_key, @channel, @target, @account_id, @retry_count, @last_attempt_at, @last_error, @recovery_state, @platform_send_started_at, @entry_json, @enqueued_at, @updated_at, @failed_at)`,
          );
          for (const item of imports) {
            const { snapshot, sourceKey, row } = item;
            assertLegacyMigrationSourceUnchanged({
              sourcePath: snapshot.sourcePath,
              snapshot,
              label: queue.label,
            });
            // Import receipts outlive queue consumption and payload-free terminal compaction.
            // Retrying cleanup must never recreate an already-delivered row.
            const receipt = readLegacyMigrationReceiptFromDatabase(db, sourceKey);
            if (receipt) {
              const report = asNullableRecord(JSON.parse(receipt.reportJson));
              const reason = report?.reason;
              const mediaPaths = report?.mediaPaths;
              if (
                typeof reason !== "string" ||
                !Array.isArray(mediaPaths) ||
                !mediaPaths.every((value) => typeof value === "string")
              ) {
                throw new Error("Legacy delivery import receipt has no verified disposition");
              }
              committed.push({
                ...item,
                reason: reason === "imported" ? undefined : reason,
                mediaPaths,
                mediaBackups: report?.mediaBackups,
              });
              continue;
            }
            if (row) {
              const existing = db
                .prepare("SELECT * FROM delivery_queue_entries WHERE queue_name = ? AND id = ?")
                .get(queue.queueName, row.id);
              if (existing && !legacyDeliveryQueueRowsMatch(existing, row)) {
                conflicts.push(row.id);
                continue;
              }
              if (!existing) {
                insert.run(row);
                imported++;
              }
            }
            recordLegacyMigrationReceipt(db, {
              sourceKey,
              migrationKind: "delivery-queues",
              sourcePath: snapshot.sourcePath,
              targetTable: "delivery_queue_entries",
              sourceSha256: snapshot.sha256,
              sourceSizeBytes: snapshot.size,
              sourceRecordCount: 1,
              runId: randomUUID(),
              now,
              reportJson: JSON.stringify({
                queueName: queue.queueName,
                reason: item.reason ?? "imported",
                mediaPaths: item.mediaPaths,
                mediaPreserved: item.mediaPaths.length === 0,
              }),
            });
            committed.push(item);
          }
        },
        { env },
      );
    } catch (error) {
      refused = true;
      warnings.push(`Failed migrating ${queue.label} ${queueDir}: ${String(error)}`);
      continue;
    }
    if (imported > 0) {
      changes.push(
        `Migrated ${imported} ${queue.label} ${imported === 1 ? "entry" : "entries"} → shared SQLite state`,
      );
    }
    if (conflicts.length > 0) {
      refused = true;
      warnings.push(
        `Left ${queue.label} in place because ${conflicts.length} ${conflicts.length === 1 ? "entry" : "entries"} already existed in shared state: ${conflicts[0]}`,
      );
    }
    for (const { snapshot, sourceKey, reason, mediaPaths, mediaBackups } of committed) {
      // Keep delivered evidence while its pending twin could still need repair.
      // Unrelated conflicts must not retain already-settled markers.
      const ids = markerIds.get(path.basename(snapshot.sourcePath, ".delivered"));
      // Opaque markers need their JSON twin's ID until malformed duplicates are resolved.
      if (
        reason === "delivered" &&
        [...unresolvedPendingIds].some(
          (id) => id === undefined || id === sourceIds.get(snapshot.sourcePath) || ids?.has(id),
        )
      ) {
        continue;
      }
      if (
        snapshot.sourcePath.endsWith(".delivered") &&
        ids &&
        files.some(
          (file) =>
            file.status === "pending" &&
            (ids.has(path.basename(file.sourcePath, ".json")) ||
              ids.has(sourceIds.get(file.sourcePath) ?? "")) &&
            migrationFileExists(file.sourcePath),
        )
      ) {
        continue;
      }
      const recordMediaPreservation = (preserved: boolean, copies: unknown) => {
        runOpenClawStateWriteTransaction(
          ({ db }) => {
            // This exact source is present again; reopen custody before any awaited backup check.
            db.prepare(
              "UPDATE migration_sources SET report_json = ?, removed_source = 0 WHERE source_key = ?",
            ).run(
              JSON.stringify({
                queueName: queue.queueName,
                reason: reason ?? "imported",
                mediaPaths,
                mediaPreserved: preserved,
                mediaBackups: copies,
              }),
              sourceKey,
            );
          },
          { env },
        );
      };
      try {
        assertLegacyMigrationSourceUnchanged({
          sourcePath: snapshot.sourcePath,
          snapshot,
          label: queue.label,
        });
        if (mediaPaths.length > 0) {
          recordMediaPreservation(false, mediaBackups);
        }
        // Failed-row projection deliberately strips content. Keep the original file as
        // an ordinary private migration backup, never as another runtime queue/store.
        const mediaArchive =
          mediaPaths.length > 0
            ? await (
                await import("./state-migrations.delivery-queue-media.js")
              ).preserveLegacyDeliveryQueueMedia({
                mediaPaths,
                previousBackups: mediaBackups,
                sourcePath: snapshot.sourcePath,
                stateDir: params.stateDir,
              })
            : undefined;
        if (mediaArchive) {
          // Publish backup identities before releasing spool custody or retiring JSON.
          recordMediaPreservation(true, mediaArchive.copies);
        }
        assertLegacyMigrationSourceUnchanged({
          sourcePath: snapshot.sourcePath,
          snapshot,
          label: queue.label,
        });
        const archive = archiveLegacyImportSource({
          sourcePath: snapshot.sourcePath,
          label: queue.label,
          changes,
          warnings,
        });
        if (archive) {
          markLegacyMigrationSourceRemoved(sourceKey, env);
        }
        if (reason && reason !== "delivered") {
          warnings.push(
            `Did not replay ${queue.label} source ${snapshot.sourcePath}: ${reason}. Original content is retained at ${archive?.targetPath ?? snapshot.sourcePath}${mediaArchive ? `; queue-owned media copies: ${mediaArchive.directory}` : ""}; review it before explicitly sending a new message. Do not restore it to the queue.`,
          );
        }
      } catch (error) {
        // COMMIT recorded the non-replayable source identity; safely retained leftovers
        // need cleanup, not a failed upgrade or another attempt to send them.
        warnings.push(
          `Retained ${queue.label} source or archive ${snapshot.sourcePath}; run openclaw doctor --fix to retry cleanup: ${String(error)}`,
        );
      }
    }
    try {
      removeEmptyLegacyDeliveryQueueDirs(queueDir);
    } catch (error) {
      warnings.push(`Failed cleaning empty ${queue.label} directory ${queueDir}: ${String(error)}`);
    }
  }
  return {
    changes,
    warnings,
    ...(!refused && warnings.length > 0 ? { warningDisposition: "recoverable" as const } : {}),
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
