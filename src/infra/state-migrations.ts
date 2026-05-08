import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "kysely";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import {
  listBundledChannelLegacySessionSurfaces,
  listBundledChannelLegacyStateMigrationDetectors,
} from "../channels/plugins/bundled.js";
import type { ChannelLegacyStateMigrationPlan } from "../channels/plugins/types.core.js";
import { CONFIG_AUDIT_NAMESPACE, CONFIG_AUDIT_OWNER_ID } from "../config/io.audit.js";
import {
  normalizeEnvPathOverride,
  resolveLegacyStateDirs,
  resolveNewStateDir,
  resolveOAuthDir,
  resolveStateDir,
} from "../config/paths.js";
import type { SessionEntry } from "../config/sessions.js";
import { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
import { mergeSqliteSessionEntries } from "../config/sessions/store-backend.sqlite.js";
import { replaceSqliteSessionTranscriptEvents } from "../config/sessions/transcript-store.sqlite.js";
import type { SessionScope } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { CRESTODIAN_AUDIT_NAMESPACE, CRESTODIAN_AUDIT_OWNER_ID } from "../crestodian/audit.js";
import {
  CRESTODIAN_RESCUE_PENDING_NAMESPACE,
  CRESTODIAN_RESCUE_PENDING_OWNER_ID,
  isRescuePendingOperation,
} from "../crestodian/rescue-pending-state.js";
import {
  buildAgentMainSessionKey,
  DEFAULT_AGENT_ID,
  DEFAULT_MAIN_KEY,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  recordOpenClawStateMigrationSource,
  recordOpenClawStateMigrationRun,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  executeCompiledSqliteQuerySync,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { normalizeConversationRef } from "./outbound/session-binding-normalization.js";
import type { SessionBindingRecord } from "./outbound/session-binding.types.js";
import { isWithinDir } from "./path-safety.js";
import {
  ensureDir,
  existsDir,
  fileExists,
  readSessionStoreJson5,
  type SessionEntryLike,
  safeReadDir,
} from "./state-migrations.fs.js";

export type LegacyStateDetection = {
  targetAgentId: string;
  targetMainKey: string;
  targetScope?: SessionScope;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  oauthDir: string;
  sessions: {
    legacyDir: string;
    legacyStorePath: string;
    targetDir: string;
    targetStorePath: string;
    hasLegacy: boolean;
    legacyKeys: string[];
  };
  agentDir: {
    legacyDir: string;
    targetDir: string;
    hasLegacy: boolean;
  };
  channelPlans: {
    hasLegacy: boolean;
    plans: ChannelLegacyStateMigrationPlan[];
  };
  sqlite: {
    hasLegacy: boolean;
    legacyTables: string[];
  };
  preview: string[];
};

let autoMigrateStateDirChecked = false;

type LegacySessionSurface = {
  isLegacyGroupSessionKey?: (key: string) => boolean;
  canonicalizeLegacySessionKey?: (params: {
    key: string;
    agentId: string;
  }) => string | null | undefined;
};

type MigrationSourceReport = {
  kind: string;
  sourcePath?: string;
  targetPath?: string;
  sourceTable?: string;
  targetTable?: string;
  sizeBytes?: number;
  mtimeMs?: number;
  sha256?: string;
  recordCount?: number;
};

function parseJsonlEvents(filePath: string): unknown[] {
  const raw = fs.readFileSync(filePath, "utf-8");
  const events: unknown[] = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) {
      continue;
    }
    try {
      events.push(JSON.parse(line));
    } catch (err) {
      throw new Error(`Invalid JSONL at ${filePath}:${index + 1}`, { cause: err });
    }
  }
  return events;
}

function hashFileSha256(filePath: string): string | undefined {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return undefined;
  }
}

function legacyMigrationSourceKey(source: MigrationSourceReport): string {
  const digest = crypto
    .createHash("sha256")
    .update(
      [
        source.kind,
        source.sourcePath ?? "",
        source.targetPath ?? "",
        source.sourceTable ?? "",
        source.targetTable ?? "",
        source.sha256 ?? "",
        String(source.sizeBytes ?? ""),
        String(source.mtimeMs ?? ""),
        String(source.recordCount ?? ""),
      ].join("\0"),
      "utf8",
    )
    .digest("hex");
  return `legacy-state:${digest}`;
}

function recordLegacyMigrationSources(params: {
  env: NodeJS.ProcessEnv;
  importedAt: number;
  runId: string;
  sources: MigrationSourceReport[];
  status: "completed" | "failed" | "warning";
}): void {
  for (const source of params.sources) {
    if (!source.sourcePath || !source.targetTable) {
      continue;
    }
    recordOpenClawStateMigrationSource({
      env: params.env,
      runId: params.runId,
      migrationKind: "legacy-state",
      sourceKey: legacyMigrationSourceKey(source),
      sourcePath: source.sourcePath,
      targetTable: source.targetTable,
      status: params.status,
      importedAt: params.importedAt,
      removedSource: !fileExists(source.sourcePath),
      sourceSha256: source.sha256,
      sourceSizeBytes: source.sizeBytes,
      sourceRecordCount: source.recordCount,
      report: source as unknown as Record<string, unknown>,
    });
  }
}

function statFileSource(params: {
  kind: string;
  sourcePath: string;
  targetPath?: string;
  targetTable?: string;
  recordCount?: number;
}): MigrationSourceReport | null {
  try {
    const stat = fs.statSync(params.sourcePath);
    if (!stat.isFile() && !stat.isDirectory()) {
      return null;
    }
    return {
      kind: params.kind,
      sourcePath: params.sourcePath,
      targetPath: params.targetPath,
      targetTable: params.targetTable,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      ...(stat.isFile() ? { sha256: hashFileSha256(params.sourcePath) } : {}),
      ...(params.recordCount !== undefined ? { recordCount: params.recordCount } : {}),
    };
  } catch {
    return null;
  }
}

function countJsonlRecords(filePath: string): number | undefined {
  try {
    return fs
      .readFileSync(filePath, "utf-8")
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0).length;
  } catch {
    return undefined;
  }
}

function countSessionStoreRecords(filePath: string): number | undefined {
  const parsed = readSessionStoreJson5(filePath);
  return parsed.ok ? Object.keys(parsed.store).length : undefined;
}

function countLegacyDeliveryQueueRecords(queueDir: string): number {
  let count = 0;
  for (const entry of safeReadDir(queueDir)) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      count += 1;
    }
  }
  for (const entry of safeReadDir(path.join(queueDir, "failed"))) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      count += 1;
    }
  }
  return count;
}

function hasLegacyDeliveryQueueArtifacts(queueDir: string): boolean {
  return (
    countLegacyDeliveryQueueRecords(queueDir) > 0 ||
    safeReadDir(queueDir).some((entry) => entry.isFile() && entry.name.endsWith(".delivered"))
  );
}

function resolveSessionIdFromTranscriptEvents(events: unknown[]): string | null {
  for (const event of events) {
    if (
      event &&
      typeof event === "object" &&
      !Array.isArray(event) &&
      (event as { type?: unknown }).type === "session" &&
      typeof (event as { id?: unknown }).id === "string" &&
      (event as { id: string }).id.trim()
    ) {
      return (event as { id: string }).id;
    }
  }
  return null;
}

function importLegacyTranscriptFileToSqlite(params: {
  sourcePath: string;
  transcriptPath: string;
  agentId: string;
  env?: NodeJS.ProcessEnv;
}): { imported: number; sessionId: string } {
  const events = parseJsonlEvents(params.sourcePath);
  const sessionId = resolveSessionIdFromTranscriptEvents(events);
  if (!sessionId) {
    throw new Error(`Transcript missing session header: ${params.sourcePath}`);
  }
  replaceSqliteSessionTranscriptEvents({
    agentId: params.agentId,
    sessionId,
    transcriptPath: params.transcriptPath,
    events,
    env: params.env,
  });
  return { imported: events.length, sessionId };
}

function getLegacySessionSurfaces(): LegacySessionSurface[] {
  // Legacy migrations run on cold doctor/startup paths. Prefer the narrower
  // setup plugin surface here so session-key cleanup does not materialize full
  // bundled channel runtimes.
  return [...listBundledChannelLegacySessionSurfaces()];
}

function isSurfaceGroupKey(key: string): boolean {
  return key.includes(":group:") || key.includes(":channel:");
}

function isLegacyGroupKey(key: string): boolean {
  const trimmed = key.trim();
  if (!trimmed) {
    return false;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  if (lower.startsWith("group:") || lower.startsWith("channel:")) {
    return true;
  }
  for (const surface of getLegacySessionSurfaces()) {
    if (surface.isLegacyGroupSessionKey?.(trimmed)) {
      return true;
    }
  }
  return false;
}

function buildLegacyMigrationPreview(plan: ChannelLegacyStateMigrationPlan): string {
  return plan.targetPath
    ? `- ${plan.label}: ${plan.sourcePath} → ${plan.targetPath}`
    : `- ${plan.label}: ${plan.sourcePath} → SQLite`;
}

async function runLegacyMigrationPlans(
  detected: LegacyStateDetection,
  plans: ChannelLegacyStateMigrationPlan[],
): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  for (const plan of plans) {
    if (plan.kind !== "custom" && fileExists(plan.targetPath)) {
      continue;
    }
    try {
      if (plan.kind === "custom") {
        const result = await plan.apply({
          cfg: detected.cfg,
          env: detected.env,
          stateDir: detected.stateDir,
          oauthDir: detected.oauthDir,
        });
        changes.push(...result.changes);
        warnings.push(...result.warnings);
        continue;
      }
      ensureDir(path.dirname(plan.targetPath));
      if (plan.kind === "move") {
        fs.renameSync(plan.sourcePath, plan.targetPath);
        changes.push(`Moved ${plan.label} → ${plan.targetPath}`);
      } else {
        fs.copyFileSync(plan.sourcePath, plan.targetPath);
        changes.push(`Copied ${plan.label} → ${plan.targetPath}`);
      }
    } catch (err) {
      warnings.push(`Failed migrating ${plan.label} (${plan.sourcePath}): ${String(err)}`);
    }
  }
  return { changes, warnings };
}

type LegacyDeliveryQueueSpec = {
  label: string;
  queueName: string;
  sourcePath: string;
};

type LegacyCurrentConversationBindingsFile = {
  version?: unknown;
  bindings?: unknown;
};

const CURRENT_CONVERSATION_BINDINGS_KV_SCOPE = "current-conversation-bindings";
const CURRENT_CONVERSATION_BINDINGS_ID_PREFIX = "generic:";

function readLegacyQueueJson(filePath: string, id: string, enqueuedAt: number): string {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return JSON.stringify({ id, enqueuedAt, retryCount: 0 });
  }
  return JSON.stringify({
    id,
    enqueuedAt,
    retryCount: 0,
    ...(parsed as Record<string, unknown>),
  });
}

function listLegacyQueueFiles(queueDir: string): {
  pending: string[];
  failed: string[];
  delivered: string[];
} {
  const pending = safeReadDir(queueDir)
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(queueDir, entry.name));
  const delivered = safeReadDir(queueDir)
    .filter((entry) => entry.isFile() && entry.name.endsWith(".delivered"))
    .map((entry) => path.join(queueDir, entry.name));
  const failedDir = path.join(queueDir, "failed");
  const failed = safeReadDir(failedDir)
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(failedDir, entry.name));
  return { pending, failed, delivered };
}

function importLegacyDeliveryQueueToSqlite(
  spec: LegacyDeliveryQueueSpec,
  env: NodeJS.ProcessEnv,
): { imported: number; removedDelivered: number } {
  const files = listLegacyQueueFiles(spec.sourcePath);
  let imported = 0;
  const rows = [
    ...files.pending.map((filePath) => ({ filePath, status: "pending" as const })),
    ...files.failed.map((filePath) => ({ filePath, status: "failed" as const })),
  ].flatMap(({ filePath, status }) => {
    try {
      const stat = fs.statSync(filePath);
      const id = path.basename(filePath, ".json");
      const enqueuedAt = stat.mtimeMs > 0 ? Math.trunc(stat.mtimeMs) : Date.now();
      const failedAt = status === "failed" ? enqueuedAt : null;
      return [
        {
          queue_name: spec.queueName,
          id,
          status,
          entry_json: readLegacyQueueJson(filePath, id, enqueuedAt),
          enqueued_at: enqueuedAt,
          updated_at: Date.now(),
          failed_at: failedAt,
          sourcePath: filePath,
        },
      ];
    } catch {
      return [];
    }
  });

  if (rows.length > 0) {
    const stateDatabase = openOpenClawStateDatabase({ env });
    const db = getNodeSqliteKysely<DeliveryQueueMigrationDatabase>(stateDatabase.db);
    for (const row of rows) {
      executeSqliteQuerySync(
        stateDatabase.db,
        db
          .insertInto("delivery_queue_entries")
          .values({
            queue_name: row.queue_name,
            id: row.id,
            status: row.status,
            entry_json: row.entry_json,
            enqueued_at: row.enqueued_at,
            updated_at: row.updated_at,
            failed_at: row.failed_at,
          })
          .onConflict((conflict) =>
            conflict.columns(["queue_name", "id"]).doUpdateSet({
              status: row.status,
              entry_json: row.entry_json,
              enqueued_at: row.enqueued_at,
              updated_at: row.updated_at,
              failed_at: row.failed_at,
            }),
          ),
      );
      fs.rmSync(row.sourcePath, { force: true });
      imported += 1;
    }
  }

  let removedDelivered = 0;
  for (const filePath of files.delivered) {
    fs.rmSync(filePath, { force: true });
    removedDelivered += 1;
  }
  removeDirIfEmpty(path.join(spec.sourcePath, "failed"));
  removeDirIfEmpty(spec.sourcePath);
  return { imported, removedDelivered };
}

function importLegacyAcpxGatewayInstanceIdToSqlite(
  filePath: string,
  env: NodeJS.ProcessEnv,
): { imported: number; warnings: string[] } {
  const value = fs.readFileSync(filePath, "utf8").trim();
  if (!value) {
    fs.rmSync(filePath, { force: true });
    return { imported: 0, warnings: [`Removed empty ACPX gateway instance id file: ${filePath}`] };
  }
  const stat = fs.statSync(filePath);
  const createdAt = stat.mtimeMs > 0 ? Math.trunc(stat.mtimeMs) : Date.now();
  runOpenClawStateWriteTransaction(
    (stateDatabase) => {
      const db = getNodeSqliteKysely<PluginStateMigrationDatabase>(stateDatabase.db);
      executeSqliteQuerySync(
        stateDatabase.db,
        db
          .insertInto("plugin_state_entries")
          .values({
            plugin_id: "acpx",
            namespace: "gateway-instance",
            entry_key: "current",
            value_json: JSON.stringify({ version: 1, id: value, createdAt }),
            created_at: createdAt,
            expires_at: null,
          })
          .onConflict((conflict) =>
            conflict.columns(["plugin_id", "namespace", "entry_key"]).doUpdateSet({
              value_json: (eb) => eb.ref("excluded.value_json"),
              created_at: (eb) => eb.ref("excluded.created_at"),
              expires_at: (eb) => eb.ref("excluded.expires_at"),
            }),
          ),
      );
    },
    { env },
  );
  fs.rmSync(filePath, { force: true });
  return { imported: 1, warnings: [] };
}

function legacyFileTransferAuditKey(lineNumber: number, rawLine: string): string {
  const digest = crypto.createHash("sha256").update(rawLine, "utf8").digest("hex").slice(0, 16);
  return `legacy:${lineNumber}:${digest}`;
}

function importLegacyFileTransferAuditToSqlite(
  filePath: string,
  env: NodeJS.ProcessEnv,
): { imported: number; warnings: string[] } {
  const raw = fs.readFileSync(filePath, "utf8");
  const records: Array<{
    key: string;
    valueJson: string;
    createdAt: number;
  }> = [];
  const warnings: string[] = [];
  for (const [index, line] of raw.split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        warnings.push(`Skipped non-object file-transfer audit record at ${filePath}:${index + 1}`);
        continue;
      }
      const timestamp =
        typeof (parsed as { timestamp?: unknown }).timestamp === "string"
          ? Date.parse((parsed as { timestamp: string }).timestamp)
          : Number.NaN;
      records.push({
        key: legacyFileTransferAuditKey(index + 1, trimmed),
        valueJson: JSON.stringify(parsed),
        createdAt: Number.isFinite(timestamp) ? timestamp : Date.now(),
      });
    } catch (err) {
      warnings.push(
        `Failed reading file-transfer audit record at ${filePath}:${index + 1}: ${String(err)}`,
      );
    }
  }

  if (records.length > 0) {
    runOpenClawStateWriteTransaction(
      (stateDatabase) => {
        const db = getNodeSqliteKysely<PluginStateMigrationDatabase>(stateDatabase.db);
        for (const record of records) {
          executeSqliteQuerySync(
            stateDatabase.db,
            db
              .insertInto("plugin_state_entries")
              .values({
                plugin_id: "file-transfer",
                namespace: "audit",
                entry_key: record.key,
                value_json: record.valueJson,
                created_at: record.createdAt,
                expires_at: null,
              })
              .onConflict((conflict) =>
                conflict.columns(["plugin_id", "namespace", "entry_key"]).doUpdateSet({
                  value_json: (eb) => eb.ref("excluded.value_json"),
                  created_at: (eb) => eb.ref("excluded.created_at"),
                  expires_at: (eb) => eb.ref("excluded.expires_at"),
                }),
              ),
          );
        }
      },
      { env },
    );
  }

  if (warnings.length === 0) {
    fs.rmSync(filePath, { force: true });
    removeDirIfEmpty(path.dirname(filePath));
  }
  return { imported: records.length, warnings };
}

function legacyCrestodianAuditKey(lineNumber: number, rawLine: string): string {
  const digest = crypto.createHash("sha256").update(rawLine, "utf8").digest("hex").slice(0, 16);
  return `legacy:${lineNumber}:${digest}`;
}

function legacyConfigAuditKey(lineNumber: number, rawLine: string): string {
  const digest = crypto.createHash("sha256").update(rawLine, "utf8").digest("hex").slice(0, 16);
  return `legacy:${lineNumber}:${digest}`;
}

function importLegacyConfigAuditToSqlite(
  filePath: string,
  env: NodeJS.ProcessEnv,
): { imported: number; warnings: string[] } {
  const raw = fs.readFileSync(filePath, "utf8");
  const records: Array<{
    key: string;
    valueJson: string;
    createdAt: number;
  }> = [];
  const warnings: string[] = [];
  for (const [index, line] of raw.split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        warnings.push(`Skipped non-object config audit record at ${filePath}:${index + 1}`);
        continue;
      }
      const timestamp =
        typeof (parsed as { ts?: unknown }).ts === "string"
          ? Date.parse((parsed as { ts: string }).ts)
          : Number.NaN;
      records.push({
        key: legacyConfigAuditKey(index + 1, trimmed),
        valueJson: JSON.stringify(parsed),
        createdAt: Number.isFinite(timestamp) ? timestamp : Date.now(),
      });
    } catch (err) {
      warnings.push(
        `Failed reading config audit record at ${filePath}:${index + 1}: ${String(err)}`,
      );
    }
  }

  if (records.length > 0) {
    runOpenClawStateWriteTransaction(
      (stateDatabase) => {
        const db = getNodeSqliteKysely<PluginStateMigrationDatabase>(stateDatabase.db);
        for (const record of records) {
          executeSqliteQuerySync(
            stateDatabase.db,
            db
              .insertInto("plugin_state_entries")
              .values({
                plugin_id: CONFIG_AUDIT_OWNER_ID,
                namespace: CONFIG_AUDIT_NAMESPACE,
                entry_key: record.key,
                value_json: record.valueJson,
                created_at: record.createdAt,
                expires_at: null,
              })
              .onConflict((conflict) =>
                conflict.columns(["plugin_id", "namespace", "entry_key"]).doUpdateSet({
                  value_json: (eb) => eb.ref("excluded.value_json"),
                  created_at: (eb) => eb.ref("excluded.created_at"),
                  expires_at: (eb) => eb.ref("excluded.expires_at"),
                }),
              ),
          );
        }
      },
      { env },
    );
  }

  if (warnings.length === 0) {
    fs.rmSync(filePath, { force: true });
    removeDirIfEmpty(path.dirname(filePath));
  }
  return { imported: records.length, warnings };
}

function importLegacyCrestodianAuditToSqlite(
  filePath: string,
  env: NodeJS.ProcessEnv,
): { imported: number; warnings: string[] } {
  const raw = fs.readFileSync(filePath, "utf8");
  const records: Array<{
    key: string;
    valueJson: string;
    createdAt: number;
  }> = [];
  const warnings: string[] = [];
  for (const [index, line] of raw.split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        warnings.push(`Skipped non-object Crestodian audit record at ${filePath}:${index + 1}`);
        continue;
      }
      const timestamp =
        typeof (parsed as { timestamp?: unknown }).timestamp === "string"
          ? Date.parse((parsed as { timestamp: string }).timestamp)
          : Number.NaN;
      records.push({
        key: legacyCrestodianAuditKey(index + 1, trimmed),
        valueJson: JSON.stringify(parsed),
        createdAt: Number.isFinite(timestamp) ? timestamp : Date.now(),
      });
    } catch (err) {
      warnings.push(
        `Failed reading Crestodian audit record at ${filePath}:${index + 1}: ${String(err)}`,
      );
    }
  }

  if (records.length > 0) {
    runOpenClawStateWriteTransaction(
      (stateDatabase) => {
        const db = getNodeSqliteKysely<PluginStateMigrationDatabase>(stateDatabase.db);
        for (const record of records) {
          executeSqliteQuerySync(
            stateDatabase.db,
            db
              .insertInto("plugin_state_entries")
              .values({
                plugin_id: CRESTODIAN_AUDIT_OWNER_ID,
                namespace: CRESTODIAN_AUDIT_NAMESPACE,
                entry_key: record.key,
                value_json: record.valueJson,
                created_at: record.createdAt,
                expires_at: null,
              })
              .onConflict((conflict) =>
                conflict.columns(["plugin_id", "namespace", "entry_key"]).doUpdateSet({
                  value_json: (eb) => eb.ref("excluded.value_json"),
                  created_at: (eb) => eb.ref("excluded.created_at"),
                  expires_at: (eb) => eb.ref("excluded.expires_at"),
                }),
              ),
          );
        }
      },
      { env },
    );
  }

  if (warnings.length === 0) {
    fs.rmSync(filePath, { force: true });
    removeDirIfEmpty(path.dirname(filePath));
  }
  return { imported: records.length, warnings };
}

function isLegacyPhoneControlArmState(parsed: unknown): parsed is Record<string, unknown> {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1 && record.version !== 2) {
    return false;
  }
  if (typeof record.armedAtMs !== "number") {
    return false;
  }
  if (!(record.expiresAtMs === null || typeof record.expiresAtMs === "number")) {
    return false;
  }
  if (record.version === 1) {
    return (
      Array.isArray(record.removedFromDeny) &&
      record.removedFromDeny.every((value) => typeof value === "string")
    );
  }
  const group = typeof record.group === "string" ? record.group : "";
  return (
    (group === "camera" || group === "screen" || group === "writes" || group === "all") &&
    Array.isArray(record.armedCommands) &&
    record.armedCommands.every((value) => typeof value === "string") &&
    Array.isArray(record.addedToAllow) &&
    record.addedToAllow.every((value) => typeof value === "string") &&
    Array.isArray(record.removedFromDeny) &&
    record.removedFromDeny.every((value) => typeof value === "string")
  );
}

function importLegacyPhoneControlArmStateToSqlite(
  filePath: string,
  env: NodeJS.ProcessEnv,
): { imported: number; warnings: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch (err) {
    return {
      imported: 0,
      warnings: [`Failed reading phone-control arm state ${filePath}: ${String(err)}`],
    };
  }
  if (!isLegacyPhoneControlArmState(parsed)) {
    return {
      imported: 0,
      warnings: [`Skipped invalid phone-control arm state: ${filePath}`],
    };
  }
  const stat = fs.statSync(filePath);
  const createdAt = stat.mtimeMs > 0 ? Math.trunc(stat.mtimeMs) : Date.now();
  runOpenClawStateWriteTransaction(
    (stateDatabase) => {
      const db = getNodeSqliteKysely<PluginStateMigrationDatabase>(stateDatabase.db);
      executeSqliteQuerySync(
        stateDatabase.db,
        db
          .insertInto("plugin_state_entries")
          .values({
            plugin_id: "phone-control",
            namespace: "arm-state",
            entry_key: "current",
            value_json: JSON.stringify(parsed),
            created_at: createdAt,
            expires_at: null,
          })
          .onConflict((conflict) =>
            conflict.columns(["plugin_id", "namespace", "entry_key"]).doUpdateSet({
              value_json: (eb) => eb.ref("excluded.value_json"),
              created_at: (eb) => eb.ref("excluded.created_at"),
              expires_at: (eb) => eb.ref("excluded.expires_at"),
            }),
          ),
      );
    },
    { env },
  );
  fs.rmSync(filePath, { force: true });
  removeDirIfEmpty(path.dirname(filePath));
  return { imported: 1, warnings: [] };
}

function importLegacyCrestodianRescuePendingToSqlite(
  dirPath: string,
  env: NodeJS.ProcessEnv,
): { imported: number; warnings: string[] } {
  const files = safeReadDir(dirPath)
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(dirPath, entry.name));
  const records: Array<{
    key: string;
    valueJson: string;
    createdAt: number;
    sourcePath: string;
  }> = [];
  const warnings: string[] = [];
  for (const filePath of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
      if (!isRescuePendingOperation(parsed)) {
        warnings.push(`Skipped invalid Crestodian rescue pending state: ${filePath}`);
        continue;
      }
      const createdAt = Date.parse(parsed.createdAt);
      records.push({
        key: path.basename(filePath, ".json"),
        valueJson: JSON.stringify(parsed),
        createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
        sourcePath: filePath,
      });
    } catch (err) {
      warnings.push(`Failed reading Crestodian rescue pending state ${filePath}: ${String(err)}`);
    }
  }

  if (records.length > 0) {
    runOpenClawStateWriteTransaction(
      (stateDatabase) => {
        const db = getNodeSqliteKysely<PluginStateMigrationDatabase>(stateDatabase.db);
        for (const record of records) {
          executeSqliteQuerySync(
            stateDatabase.db,
            db
              .insertInto("plugin_state_entries")
              .values({
                plugin_id: CRESTODIAN_RESCUE_PENDING_OWNER_ID,
                namespace: CRESTODIAN_RESCUE_PENDING_NAMESPACE,
                entry_key: record.key,
                value_json: record.valueJson,
                created_at: record.createdAt,
                expires_at: null,
              })
              .onConflict((conflict) =>
                conflict.columns(["plugin_id", "namespace", "entry_key"]).doUpdateSet({
                  value_json: (eb) => eb.ref("excluded.value_json"),
                  created_at: (eb) => eb.ref("excluded.created_at"),
                  expires_at: (eb) => eb.ref("excluded.expires_at"),
                }),
              ),
          );
        }
      },
      { env },
    );
  }

  if (warnings.length === 0) {
    for (const record of records) {
      fs.rmSync(record.sourcePath, { force: true });
    }
    removeDirIfEmpty(dirPath);
    removeDirIfEmpty(path.dirname(dirPath));
  }
  return { imported: records.length, warnings };
}

function buildCurrentConversationKey(record: SessionBindingRecord): string | null {
  if (!record?.conversation?.conversationId) {
    return null;
  }
  const conversation = normalizeConversationRef(record.conversation);
  const targetSessionKey = record.targetSessionKey?.trim() ?? "";
  if (!conversation.channel || !conversation.conversationId || !targetSessionKey) {
    return null;
  }
  return [
    conversation.channel,
    conversation.accountId,
    conversation.parentConversationId ?? "",
    conversation.conversationId,
  ].join("\u241f");
}

function importLegacyCurrentConversationBindingsToSqlite(
  filePath: string,
  env: NodeJS.ProcessEnv,
): { imported: number; warnings: string[] } {
  let parsed: LegacyCurrentConversationBindingsFile | undefined;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as LegacyCurrentConversationBindingsFile;
  } catch (err) {
    return {
      imported: 0,
      warnings: [`Failed reading current conversation bindings ${filePath}: ${String(err)}`],
    };
  }
  const bindings = parsed?.version === 1 && Array.isArray(parsed.bindings) ? parsed.bindings : [];
  const stat = fs.statSync(filePath);
  const updatedAt = stat.mtimeMs > 0 ? Math.trunc(stat.mtimeMs) : Date.now();
  let imported = 0;
  runOpenClawStateWriteTransaction(
    (stateDatabase) => {
      const db = getNodeSqliteKysely<KvMigrationDatabase>(stateDatabase.db);
      for (const candidate of bindings) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
          continue;
        }
        const record = candidate as SessionBindingRecord;
        const key = buildCurrentConversationKey(record);
        if (!key) {
          continue;
        }
        const conversation = normalizeConversationRef(record.conversation);
        const normalized: SessionBindingRecord = {
          ...record,
          bindingId: `${CURRENT_CONVERSATION_BINDINGS_ID_PREFIX}${key}`,
          targetSessionKey: record.targetSessionKey.trim(),
          conversation,
        };
        executeSqliteQuerySync(
          stateDatabase.db,
          db
            .insertInto("kv")
            .values({
              scope: CURRENT_CONVERSATION_BINDINGS_KV_SCOPE,
              key,
              value_json: JSON.stringify({ version: 1, binding: normalized }),
              updated_at: updatedAt,
            })
            .onConflict((conflict) =>
              conflict.columns(["scope", "key"]).doUpdateSet({
                value_json: (eb) => eb.ref("excluded.value_json"),
                updated_at: (eb) => eb.ref("excluded.updated_at"),
              }),
            ),
        );
        imported += 1;
      }
    },
    { env },
  );
  fs.rmSync(filePath, { force: true });
  return { imported, warnings: [] };
}

type LegacyClawHubSkillOrigin = {
  version: 1;
  registry: string;
  slug: string;
  installedVersion: string;
  installedAt: number;
};

type LegacyClawHubSkillRecord = LegacyClawHubSkillOrigin & {
  workspaceDir: string;
  targetDir: string;
  updatedAt: number;
};

function normalizeLegacyClawHubSlug(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const slug = raw.trim();
  if (!slug || slug.includes("/") || slug.includes("\\") || slug.includes("..")) {
    return null;
  }
  return slug;
}

function isLegacyClawHubSkillOrigin(parsed: unknown): parsed is LegacyClawHubSkillOrigin {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const record = parsed as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.registry === "string" &&
    normalizeLegacyClawHubSlug(record.slug) !== null &&
    typeof record.installedVersion === "string" &&
    typeof record.installedAt === "number"
  );
}

function clawHubWorkspaceKey(workspaceDir: string): string {
  return crypto.createHash("sha256").update(path.resolve(workspaceDir)).digest("hex").slice(0, 24);
}

function clawHubSkillInstallKey(workspaceDir: string, slug: string): string {
  return `${clawHubWorkspaceKey(workspaceDir)}:${slug}`;
}

function resolveConfiguredClawHubWorkspaceDirs(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const agentId of listAgentIds(cfg)) {
    const workspaceDir = path.resolve(resolveAgentWorkspaceDir(cfg, agentId, env));
    if (seen.has(workspaceDir)) {
      continue;
    }
    seen.add(workspaceDir);
    dirs.push(workspaceDir);
  }
  return dirs;
}

function collectLegacyClawHubSourceFiles(workspaceDir: string): string[] {
  const files: string[] = [];
  for (const dotDir of [".clawhub", ".clawdhub"]) {
    const lockPath = path.join(workspaceDir, dotDir, "lock.json");
    if (fileExists(lockPath)) {
      files.push(lockPath);
    }
  }
  const skillsDir = path.join(workspaceDir, "skills");
  for (const entry of safeReadDir(skillsDir)) {
    if (!entry.isDirectory()) {
      continue;
    }
    for (const dotDir of [".clawhub", ".clawdhub"]) {
      const originPath = path.join(skillsDir, entry.name, dotDir, "origin.json");
      if (fileExists(originPath)) {
        files.push(originPath);
      }
    }
  }
  return files.toSorted();
}

function mergeLegacyClawHubRecord(
  records: Map<string, LegacyClawHubSkillRecord>,
  record: LegacyClawHubSkillRecord,
): void {
  const existing = records.get(record.slug);
  records.set(record.slug, {
    ...existing,
    ...record,
    registry: record.registry || existing?.registry || DEFAULT_CLAWHUB_URL,
    installedVersion: record.installedVersion || existing?.installedVersion || "",
    installedAt: record.installedAt || existing?.installedAt || record.updatedAt,
    workspaceDir: path.resolve(record.workspaceDir),
    targetDir: path.resolve(record.targetDir),
    updatedAt: Math.max(record.updatedAt, existing?.updatedAt ?? 0),
  });
}

function importLegacyClawHubSkillTrackingToSqlite(
  workspaceDir: string,
  env: NodeJS.ProcessEnv,
): { imported: number; warnings: string[]; sourceFiles: string[] } {
  const sourceFiles = collectLegacyClawHubSourceFiles(workspaceDir);
  const warnings: string[] = [];
  const records = new Map<string, LegacyClawHubSkillRecord>();
  const resolvedWorkspaceDir = path.resolve(workspaceDir);

  for (const lockPath of [
    path.join(workspaceDir, ".clawhub", "lock.json"),
    path.join(workspaceDir, ".clawdhub", "lock.json"),
  ]) {
    if (!fileExists(lockPath)) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as unknown;
    } catch (err) {
      warnings.push(`Failed reading ClawHub skill lock ${lockPath}: ${String(err)}`);
      continue;
    }
    const lock = parsed as { version?: unknown; skills?: unknown };
    if (lock?.version !== 1 || !lock.skills || typeof lock.skills !== "object") {
      warnings.push(`Skipped invalid ClawHub skill lock: ${lockPath}`);
      continue;
    }
    const stat = fs.statSync(lockPath);
    const updatedAt = stat.mtimeMs > 0 ? Math.trunc(stat.mtimeMs) : Date.now();
    for (const [rawSlug, value] of Object.entries(lock.skills as Record<string, unknown>)) {
      const slug = normalizeLegacyClawHubSlug(rawSlug);
      const entry = value as { version?: unknown; installedAt?: unknown };
      if (!slug || typeof entry.version !== "string" || typeof entry.installedAt !== "number") {
        warnings.push(`Skipped invalid ClawHub skill lock entry ${rawSlug} in ${lockPath}`);
        continue;
      }
      mergeLegacyClawHubRecord(records, {
        version: 1,
        registry: DEFAULT_CLAWHUB_URL,
        slug,
        installedVersion: entry.version,
        installedAt: entry.installedAt,
        workspaceDir: resolvedWorkspaceDir,
        targetDir: path.join(resolvedWorkspaceDir, "skills", slug),
        updatedAt,
      });
    }
  }

  for (const entry of safeReadDir(path.join(workspaceDir, "skills"))) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillDir = path.join(workspaceDir, "skills", entry.name);
    for (const dotDir of [".clawhub", ".clawdhub"]) {
      const originPath = path.join(skillDir, dotDir, "origin.json");
      if (!fileExists(originPath)) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(originPath, "utf8")) as unknown;
      } catch (err) {
        warnings.push(`Failed reading ClawHub skill origin ${originPath}: ${String(err)}`);
        continue;
      }
      if (!isLegacyClawHubSkillOrigin(parsed)) {
        warnings.push(`Skipped invalid ClawHub skill origin: ${originPath}`);
        continue;
      }
      const stat = fs.statSync(originPath);
      mergeLegacyClawHubRecord(records, {
        ...parsed,
        workspaceDir: resolvedWorkspaceDir,
        targetDir: skillDir,
        updatedAt: stat.mtimeMs > 0 ? Math.trunc(stat.mtimeMs) : Date.now(),
      });
    }
  }

  if (records.size > 0) {
    runOpenClawStateWriteTransaction(
      (stateDatabase) => {
        const db = getNodeSqliteKysely<PluginStateMigrationDatabase>(stateDatabase.db);
        for (const record of records.values()) {
          executeSqliteQuerySync(
            stateDatabase.db,
            db
              .insertInto("plugin_state_entries")
              .values({
                plugin_id: CLAWHUB_SKILL_STATE_OWNER_ID,
                namespace: CLAWHUB_SKILL_STATE_NAMESPACE,
                entry_key: clawHubSkillInstallKey(record.workspaceDir, record.slug),
                value_json: JSON.stringify(record),
                created_at: record.installedAt,
                expires_at: null,
              })
              .onConflict((conflict) =>
                conflict.columns(["plugin_id", "namespace", "entry_key"]).doUpdateSet({
                  value_json: (eb) => eb.ref("excluded.value_json"),
                  created_at: (eb) => eb.ref("excluded.created_at"),
                  expires_at: (eb) => eb.ref("excluded.expires_at"),
                }),
              ),
          );
        }
      },
      { env },
    );
  }

  if (warnings.length === 0) {
    for (const sourcePath of sourceFiles) {
      fs.rmSync(sourcePath, { force: true });
      removeDirIfEmpty(path.dirname(sourcePath));
    }
    removeDirIfEmpty(path.join(workspaceDir, ".clawhub"));
    removeDirIfEmpty(path.join(workspaceDir, ".clawdhub"));
  }

  return { imported: records.size, warnings, sourceFiles };
}

function collectCoreLegacyStateMigrationPlans(params: {
  stateDir: string;
  env: NodeJS.ProcessEnv;
  cfg: OpenClawConfig;
}): ChannelLegacyStateMigrationPlan[] {
  const specs: LegacyDeliveryQueueSpec[] = [
    {
      label: "Outbound delivery queue",
      queueName: "outbound-delivery",
      sourcePath: path.join(params.stateDir, "delivery-queue"),
    },
    {
      label: "Session delivery queue",
      queueName: "session-delivery",
      sourcePath: path.join(params.stateDir, "session-delivery-queue"),
    },
  ];
  const plans: ChannelLegacyStateMigrationPlan[] = specs.flatMap((spec) => {
    if (!hasLegacyDeliveryQueueArtifacts(spec.sourcePath)) {
      return [];
    }
    return [
      {
        kind: "custom" as const,
        label: spec.label,
        sourcePath: spec.sourcePath,
        targetTable: "delivery_queue_entries",
        recordCount: countLegacyDeliveryQueueRecords(spec.sourcePath),
        apply: () => {
          const result = importLegacyDeliveryQueueToSqlite(spec, params.env);
          const changes: string[] = [];
          if (result.imported > 0) {
            changes.push(
              `Imported ${result.imported} ${spec.label.toLowerCase()} row(s) into SQLite`,
            );
          }
          if (result.removedDelivered > 0) {
            changes.push(
              `Removed ${result.removedDelivered} delivered ${spec.label.toLowerCase()} marker(s)`,
            );
          }
          return { changes, warnings: [] as string[] };
        },
      },
    ];
  });
  const acpxGatewayInstancePath = path.join(params.stateDir, "gateway-instance-id");
  if (fileExists(acpxGatewayInstancePath)) {
    plans.push({
      kind: "custom",
      label: "ACPX gateway instance id",
      sourcePath: acpxGatewayInstancePath,
      targetTable: "plugin_state_entries",
      recordCount: 1,
      apply: () => {
        const result = importLegacyAcpxGatewayInstanceIdToSqlite(
          acpxGatewayInstancePath,
          params.env,
        );
        return {
          changes:
            result.imported > 0
              ? ["Imported ACPX gateway instance id into SQLite plugin state"]
              : [],
          warnings: result.warnings,
        };
      },
    });
  }
  const configAuditPath = path.join(params.stateDir, "logs", "config-audit.jsonl");
  if (fileExists(configAuditPath)) {
    plans.push({
      kind: "custom",
      label: "Config audit log",
      sourcePath: configAuditPath,
      targetTable: "plugin_state_entries",
      recordCount: countJsonlRecords(configAuditPath),
      apply: () => {
        const result = importLegacyConfigAuditToSqlite(configAuditPath, params.env);
        return {
          changes:
            result.imported > 0
              ? [`Imported ${result.imported} config audit record(s) into SQLite plugin state`]
              : [],
          warnings: result.warnings,
        };
      },
    });
  }
  const fileTransferAuditPath = path.join(params.stateDir, "audit", "file-transfer.jsonl");
  if (fileExists(fileTransferAuditPath)) {
    plans.push({
      kind: "custom",
      label: "File transfer audit log",
      sourcePath: fileTransferAuditPath,
      targetTable: "plugin_state_entries",
      recordCount: countJsonlRecords(fileTransferAuditPath),
      apply: () => {
        const result = importLegacyFileTransferAuditToSqlite(fileTransferAuditPath, params.env);
        return {
          changes:
            result.imported > 0
              ? [
                  `Imported ${result.imported} file-transfer audit record(s) into SQLite plugin state`,
                ]
              : [],
          warnings: result.warnings,
        };
      },
    });
  }
  const crestodianAuditPath = path.join(params.stateDir, "audit", "crestodian.jsonl");
  if (fileExists(crestodianAuditPath)) {
    plans.push({
      kind: "custom",
      label: "Crestodian audit log",
      sourcePath: crestodianAuditPath,
      targetTable: "plugin_state_entries",
      recordCount: countJsonlRecords(crestodianAuditPath),
      apply: () => {
        const result = importLegacyCrestodianAuditToSqlite(crestodianAuditPath, params.env);
        return {
          changes:
            result.imported > 0
              ? [`Imported ${result.imported} Crestodian audit record(s) into SQLite plugin state`]
              : [],
          warnings: result.warnings,
        };
      },
    });
  }
  const phoneControlArmStatePath = path.join(
    params.stateDir,
    "plugins",
    "phone-control",
    "armed.json",
  );
  if (fileExists(phoneControlArmStatePath)) {
    plans.push({
      kind: "custom",
      label: "Phone Control arm state",
      sourcePath: phoneControlArmStatePath,
      targetTable: "plugin_state_entries",
      recordCount: 1,
      apply: () => {
        const result = importLegacyPhoneControlArmStateToSqlite(
          phoneControlArmStatePath,
          params.env,
        );
        return {
          changes:
            result.imported > 0
              ? ["Imported Phone Control arm state into SQLite plugin state"]
              : [],
          warnings: result.warnings,
        };
      },
    });
  }
  const crestodianRescuePendingDir = path.join(params.stateDir, "crestodian", "rescue-pending");
  const crestodianRescuePendingCount = safeReadDir(crestodianRescuePendingDir).filter(
    (entry) => entry.isFile() && entry.name.endsWith(".json"),
  ).length;
  if (crestodianRescuePendingCount > 0) {
    plans.push({
      kind: "custom",
      label: "Crestodian rescue pending approvals",
      sourcePath: crestodianRescuePendingDir,
      targetTable: "plugin_state_entries",
      recordCount: crestodianRescuePendingCount,
      apply: () => {
        const result = importLegacyCrestodianRescuePendingToSqlite(
          crestodianRescuePendingDir,
          params.env,
        );
        return {
          changes:
            result.imported > 0
              ? [
                  `Imported ${result.imported} Crestodian rescue pending approval(s) into SQLite plugin state`,
                ]
              : [],
          warnings: result.warnings,
        };
      },
    });
  }
  const currentConversationBindingsPath = path.join(
    params.stateDir,
    "bindings",
    "current-conversations.json",
  );
  if (fileExists(currentConversationBindingsPath)) {
    plans.push({
      kind: "custom",
      label: "Current conversation bindings",
      sourcePath: currentConversationBindingsPath,
      targetTable: "kv",
      recordCount: 1,
      apply: () => {
        const result = importLegacyCurrentConversationBindingsToSqlite(
          currentConversationBindingsPath,
          params.env,
        );
        return {
          changes:
            result.imported > 0
              ? [`Imported ${result.imported} current conversation binding(s) into SQLite state`]
              : [],
          warnings: result.warnings,
        };
      },
    });
  }
  for (const workspaceDir of resolveConfiguredClawHubWorkspaceDirs(params.cfg, params.env)) {
    const sourceFiles = collectLegacyClawHubSourceFiles(workspaceDir);
    if (sourceFiles.length === 0) {
      continue;
    }
    plans.push({
      kind: "custom",
      label: "ClawHub skill install tracking",
      sourcePath: workspaceDir,
      targetTable: "plugin_state_entries",
      recordCount: sourceFiles.length,
      apply: () => {
        const result = importLegacyClawHubSkillTrackingToSqlite(workspaceDir, params.env);
        return {
          changes:
            result.imported > 0
              ? [
                  `Imported ${result.imported} ClawHub skill install record(s) into SQLite plugin state`,
                ]
              : [],
          warnings: result.warnings,
        };
      },
    });
  }
  return plans;
}

function canonicalizeSessionKeyForAgent(params: {
  key: string;
  agentId: string;
  mainKey: string;
  scope?: SessionScope;
  skipCrossAgentRemap?: boolean;
}): string {
  const agentId = normalizeAgentId(params.agentId);
  const raw = params.key.trim();
  if (!raw) {
    return raw;
  }
  const rawLower = normalizeLowercaseStringOrEmpty(raw);
  if (rawLower === "global" || rawLower === "unknown") {
    return rawLower;
  }

  // When shared-store guard is active, do not remap keys that belong to a
  // different agent — they are legitimate records for that agent, not orphans.
  // Without this check, canonicalizeMainSessionAlias (which now recognises
  // legacy agent:main:* aliases) would rewrite them before the
  // skipCrossAgentRemap guard below has a chance to block it.
  if (params.skipCrossAgentRemap) {
    const parsed = parseAgentSessionKey(raw);
    if (parsed && normalizeAgentId(parsed.agentId) !== agentId) {
      return rawLower;
    }
    if (
      agentId !== DEFAULT_AGENT_ID &&
      (rawLower === DEFAULT_MAIN_KEY || rawLower === params.mainKey)
    ) {
      return rawLower;
    }
  }

  const canonicalMain = canonicalizeMainSessionAlias({
    cfg: { session: { scope: params.scope, mainKey: params.mainKey } },
    agentId,
    sessionKey: raw,
  });
  if (canonicalMain !== raw) {
    return normalizeLowercaseStringOrEmpty(canonicalMain);
  }

  // Handle cross-agent orphaned main-session keys: "agent:main:main" or
  // "agent:main:<mainKey>" in a store belonging to a different agent (e.g.
  // "ops"). Only remap provable orphan aliases — other agent:main:* keys
  // (hooks, subagents, cron, per-sender) may be intentional cross-agent
  // references and must not be touched (#29683).
  const defaultPrefix = `agent:${DEFAULT_AGENT_ID}:`;
  if (
    rawLower.startsWith(defaultPrefix) &&
    agentId !== DEFAULT_AGENT_ID &&
    !params.skipCrossAgentRemap
  ) {
    const rest = rawLower.slice(defaultPrefix.length);
    const isOrphanAlias = rest === DEFAULT_MAIN_KEY || rest === params.mainKey;
    if (isOrphanAlias) {
      const remapped = `agent:${agentId}:${rest}`;
      const canonicalized = canonicalizeMainSessionAlias({
        cfg: { session: { scope: params.scope, mainKey: params.mainKey } },
        agentId,
        sessionKey: remapped,
      });
      return normalizeLowercaseStringOrEmpty(canonicalized);
    }
  }

  if (rawLower.startsWith("agent:")) {
    return rawLower;
  }
  if (rawLower.startsWith("subagent:")) {
    const rest = raw.slice("subagent:".length);
    return normalizeLowercaseStringOrEmpty(`agent:${agentId}:subagent:${rest}`);
  }
  // Channel-owned legacy shapes must win before the generic group/channel
  // fallback so plugin-specific legacy group keys can canonicalize to their
  // owning channel instead of the generic `...:unknown:group:...` bucket.
  for (const surface of getLegacySessionSurfaces()) {
    const canonicalized = surface.canonicalizeLegacySessionKey?.({
      key: raw,
      agentId,
    });
    const normalizedCanonicalized = normalizeOptionalLowercaseString(canonicalized);
    if (normalizedCanonicalized) {
      return normalizedCanonicalized;
    }
  }
  if (rawLower.startsWith("group:") || rawLower.startsWith("channel:")) {
    return normalizeLowercaseStringOrEmpty(`agent:${agentId}:unknown:${raw}`);
  }
  if (isSurfaceGroupKey(raw)) {
    return normalizeLowercaseStringOrEmpty(`agent:${agentId}:${raw}`);
  }
  return normalizeLowercaseStringOrEmpty(`agent:${agentId}:${raw}`);
}

function pickLatestLegacyDirectEntry(
  store: Record<string, SessionEntryLike>,
): SessionEntryLike | null {
  let best: SessionEntryLike | null = null;
  let bestUpdated = -1;
  for (const [key, entry] of Object.entries(store)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const normalized = key.trim();
    if (!normalized) {
      continue;
    }
    if (normalized === "global") {
      continue;
    }
    if (normalized.startsWith("agent:")) {
      continue;
    }
    if (normalizeLowercaseStringOrEmpty(normalized).startsWith("subagent:")) {
      continue;
    }
    if (isLegacyGroupKey(normalized) || isSurfaceGroupKey(normalized)) {
      continue;
    }
    const updatedAt = typeof entry.updatedAt === "number" ? entry.updatedAt : 0;
    if (updatedAt > bestUpdated) {
      bestUpdated = updatedAt;
      best = entry;
    }
  }
  return best;
}

function normalizeSessionEntry(entry: SessionEntryLike): SessionEntry | null {
  const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : null;
  if (!sessionId) {
    return null;
  }
  const updatedAt =
    typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
      ? entry.updatedAt
      : Date.now();
  const normalized = { ...(entry as unknown as SessionEntry), sessionId, updatedAt };
  const rec = normalized as unknown as Record<string, unknown>;
  if (typeof rec.groupChannel !== "string" && typeof rec.room === "string") {
    rec.groupChannel = rec.room;
  }
  delete rec.room;
  return normalized;
}

function resolveUpdatedAt(entry: SessionEntryLike): number {
  return typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
    ? entry.updatedAt
    : 0;
}

function mergeSessionEntry(params: {
  existing: SessionEntryLike | undefined;
  incoming: SessionEntryLike;
  preferIncomingOnTie?: boolean;
}): SessionEntryLike {
  if (!params.existing) {
    return params.incoming;
  }
  const existingUpdated = resolveUpdatedAt(params.existing);
  const incomingUpdated = resolveUpdatedAt(params.incoming);
  if (incomingUpdated > existingUpdated) {
    return params.incoming;
  }
  if (incomingUpdated < existingUpdated) {
    return params.existing;
  }
  return params.preferIncomingOnTie ? params.incoming : params.existing;
}

function canonicalizeSessionStore(params: {
  store: Record<string, SessionEntryLike>;
  agentId: string;
  mainKey: string;
  scope?: SessionScope;
  skipCrossAgentRemap?: boolean;
}): { store: Record<string, SessionEntryLike>; legacyKeys: string[] } {
  const canonical: Record<string, SessionEntryLike> = {};
  const meta = new Map<string, { isCanonical: boolean; updatedAt: number }>();
  const legacyKeys: string[] = [];

  for (const [key, entry] of Object.entries(params.store)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const canonicalKey = canonicalizeSessionKeyForAgent({
      key,
      agentId: params.agentId,
      mainKey: params.mainKey,
      scope: params.scope,
      skipCrossAgentRemap: params.skipCrossAgentRemap,
    });
    const isCanonical = canonicalKey === key;
    if (!isCanonical) {
      legacyKeys.push(key);
    }
    const existing = canonical[canonicalKey];
    if (!existing) {
      canonical[canonicalKey] = entry;
      meta.set(canonicalKey, { isCanonical, updatedAt: resolveUpdatedAt(entry) });
      continue;
    }

    const existingMeta = meta.get(canonicalKey);
    const incomingUpdated = resolveUpdatedAt(entry);
    const existingUpdated = existingMeta?.updatedAt ?? resolveUpdatedAt(existing);
    if (incomingUpdated > existingUpdated) {
      canonical[canonicalKey] = entry;
      meta.set(canonicalKey, { isCanonical, updatedAt: incomingUpdated });
      continue;
    }
    if (incomingUpdated < existingUpdated) {
      continue;
    }
    if (existingMeta?.isCanonical && !isCanonical) {
      continue;
    }
    if (!existingMeta?.isCanonical && isCanonical) {
      canonical[canonicalKey] = entry;
      meta.set(canonicalKey, { isCanonical, updatedAt: incomingUpdated });
      continue;
    }
  }

  return { store: canonical, legacyKeys };
}

function listLegacySessionKeys(params: {
  store: Record<string, SessionEntryLike>;
  agentId: string;
  mainKey: string;
  scope?: SessionScope;
}): string[] {
  const legacy: string[] = [];
  for (const key of Object.keys(params.store)) {
    const canonical = canonicalizeSessionKeyForAgent({
      key,
      agentId: params.agentId,
      mainKey: params.mainKey,
      scope: params.scope,
    });
    if (canonical !== key) {
      legacy.push(key);
    }
  }
  return legacy;
}

function emptyDirOrMissing(dir: string): boolean {
  if (!existsDir(dir)) {
    return true;
  }
  return safeReadDir(dir).length === 0;
}

function removeDirIfEmpty(dir: string) {
  if (!existsDir(dir)) {
    return;
  }
  if (!emptyDirOrMissing(dir)) {
    return;
  }
  try {
    fs.rmdirSync(dir);
  } catch {
    // ignore
  }
}

const GLOBAL_AGENT_OWNED_SQLITE_LEGACY_TABLES = [
  "session_entries",
  "transcript_events",
  "vfs_entries",
  "tool_artifacts",
] as const;

type GlobalAgentOwnedSqliteLegacyTable = (typeof GLOBAL_AGENT_OWNED_SQLITE_LEGACY_TABLES)[number];

type LegacyGlobalSessionEntryRow = {
  agent_id?: unknown;
  session_key?: unknown;
  entry_json?: unknown;
  updated_at?: unknown;
};

type LegacyGlobalTranscriptEventRow = {
  agent_id?: unknown;
  session_id?: unknown;
  seq?: unknown;
  event_json?: unknown;
  created_at?: unknown;
};

type LegacyGlobalVfsEntryRow = {
  agent_id?: unknown;
  namespace?: unknown;
  path?: unknown;
  kind?: unknown;
  content_blob?: unknown;
  metadata_json?: unknown;
  updated_at?: unknown;
};

type LegacyGlobalToolArtifactRow = {
  agent_id?: unknown;
  run_id?: unknown;
  artifact_id?: unknown;
  kind?: unknown;
  metadata_json?: unknown;
  blob?: unknown;
  created_at?: unknown;
};

type SqliteFoundRow = {
  found?: unknown;
};

type SqliteCountRow = {
  count?: number | bigint;
};

type AgentSessionEntryMigrationDatabase = Pick<OpenClawAgentKyselyDatabase, "session_entries">;
type AgentTranscriptEventMigrationDatabase = Pick<OpenClawAgentKyselyDatabase, "transcript_events">;
type AgentVfsEntryMigrationDatabase = Pick<OpenClawAgentKyselyDatabase, "vfs_entries">;
type AgentToolArtifactMigrationDatabase = Pick<OpenClawAgentKyselyDatabase, "tool_artifacts">;
type LegacyGlobalAgentOwnedMigrationDatabase = Pick<OpenClawStateKyselyDatabase, never>;
type DeliveryQueueMigrationDatabase = Pick<OpenClawStateKyselyDatabase, "delivery_queue_entries">;
type KvMigrationDatabase = Pick<OpenClawStateKyselyDatabase, "kv">;
type PluginStateMigrationDatabase = Pick<OpenClawStateKyselyDatabase, "plugin_state_entries">;

const CLAWHUB_SKILL_STATE_OWNER_ID = "core:clawhub-skills";
const CLAWHUB_SKILL_STATE_NAMESPACE = "skill-installs";
const DEFAULT_CLAWHUB_URL = "https://clawhub.ai";

function isGlobalAgentOwnedSqliteLegacyTable(
  table: string,
): table is GlobalAgentOwnedSqliteLegacyTable {
  return GLOBAL_AGENT_OWNED_SQLITE_LEGACY_TABLES.includes(
    table as GlobalAgentOwnedSqliteLegacyTable,
  );
}

function detectGlobalAgentOwnedSqliteLegacyTables(env: NodeJS.ProcessEnv): string[] {
  const dbPath = resolveOpenClawStateSqlitePath(env);
  if (!fs.existsSync(dbPath)) {
    return [];
  }
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const found: string[] = [];
    const kysely = getNodeSqliteKysely<LegacyGlobalAgentOwnedMigrationDatabase>(db);
    for (const table of GLOBAL_AGENT_OWNED_SQLITE_LEGACY_TABLES) {
      const row = executeCompiledSqliteQuerySync<SqliteFoundRow>(
        db,
        sql`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ${table} LIMIT 1`.compile(
          kysely,
        ),
      ).rows[0];
      if (row?.found !== undefined) {
        found.push(table);
      }
    }
    return found;
  } finally {
    db.close();
  }
}

function countGlobalAgentOwnedSqliteRows(params: {
  env: NodeJS.ProcessEnv;
  table: GlobalAgentOwnedSqliteLegacyTable;
}): number | undefined {
  const dbPath = resolveOpenClawStateSqlitePath(params.env);
  if (!fs.existsSync(dbPath)) {
    return undefined;
  }
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const kysely = getNodeSqliteKysely<LegacyGlobalAgentOwnedMigrationDatabase>(db);
    const row = executeCompiledSqliteQuerySync<SqliteCountRow>(
      db,
      sql`SELECT COUNT(*) AS count FROM ${sql.raw(params.table)}`.compile(kysely),
    ).rows[0];
    return typeof row?.count === "bigint" ? Number(row.count) : row?.count;
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

function collectLegacyMigrationSources(detected: LegacyStateDetection): MigrationSourceReport[] {
  const sources: MigrationSourceReport[] = [];
  const add = (source: MigrationSourceReport | null | undefined) => {
    if (source) {
      sources.push(source);
    }
  };

  add(
    statFileSource({
      kind: "session-index",
      sourcePath: detected.sessions.legacyStorePath,
      targetTable: "agent.session_entries",
      recordCount: fileExists(detected.sessions.legacyStorePath)
        ? countSessionStoreRecords(detected.sessions.legacyStorePath)
        : undefined,
    }),
  );
  add(
    statFileSource({
      kind: "session-index",
      sourcePath: detected.sessions.targetStorePath,
      targetTable: "agent.session_entries",
      recordCount: fileExists(detected.sessions.targetStorePath)
        ? countSessionStoreRecords(detected.sessions.targetStorePath)
        : undefined,
    }),
  );

  for (const dir of [detected.sessions.legacyDir, detected.sessions.targetDir]) {
    for (const entry of safeReadDir(dir)) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      const sourcePath = path.join(dir, entry.name);
      add(
        statFileSource({
          kind: "transcript-jsonl",
          sourcePath,
          targetTable: "agent.transcript_events",
          recordCount: countJsonlRecords(sourcePath),
        }),
      );
    }
  }

  for (const entry of safeReadDir(detected.agentDir.legacyDir)) {
    if (!entry.isFile()) {
      continue;
    }
    const sourcePath = path.join(detected.agentDir.legacyDir, entry.name);
    add(
      statFileSource({
        kind: "agent-file",
        sourcePath,
        targetPath: path.join(detected.agentDir.targetDir, entry.name),
        recordCount: 1,
      }),
    );
  }

  for (const plan of detected.channelPlans.plans) {
    add(
      statFileSource({
        kind: `channel-${plan.kind}`,
        sourcePath: plan.sourcePath,
        targetPath: plan.targetPath,
        targetTable: plan.kind === "custom" ? plan.targetTable : undefined,
        recordCount: plan.kind === "custom" ? plan.recordCount : 1,
      }),
    );
  }

  const stateDbPath = resolveOpenClawStateSqlitePath(detected.env);
  for (const table of detected.sqlite.legacyTables) {
    const recordCount = isGlobalAgentOwnedSqliteLegacyTable(table)
      ? countGlobalAgentOwnedSqliteRows({ env: detected.env, table })
      : undefined;
    sources.push({
      kind: "global-sqlite-table",
      sourcePath: stateDbPath,
      sourceTable: table,
      targetTable: `agent.${table}`,
      ...(fs.existsSync(stateDbPath)
        ? {
            sizeBytes: fs.statSync(stateDbPath).size,
            mtimeMs: fs.statSync(stateDbPath).mtimeMs,
            sha256: hashFileSha256(stateDbPath),
          }
        : {}),
      recordCount,
    });
  }

  return sources.toSorted((a, b) =>
    `${a.kind}:${a.sourcePath ?? ""}:${a.sourceTable ?? ""}`.localeCompare(
      `${b.kind}:${b.sourcePath ?? ""}:${b.sourceTable ?? ""}`,
    ),
  );
}

export function resetAutoMigrateLegacyStateDirForTest() {
  autoMigrateStateDirChecked = false;
}

type StateDirMigrationResult = {
  migrated: boolean;
  skipped: boolean;
  changes: string[];
  warnings: string[];
};

function resolveSymlinkTarget(linkPath: string): string | null {
  try {
    const target = fs.readlinkSync(linkPath);
    return path.resolve(path.dirname(linkPath), target);
  } catch {
    return null;
  }
}

function formatStateDirMigration(legacyDir: string, targetDir: string): string {
  return `State dir: ${legacyDir} → ${targetDir} (legacy path now symlinked)`;
}

function isDirPath(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function isLegacyTreeSymlinkMirror(currentDir: string, realTargetDir: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return false;
  }
  if (entries.length === 0) {
    return false;
  }

  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(entryPath);
    } catch {
      return false;
    }
    if (stat.isSymbolicLink()) {
      const resolvedTarget = resolveSymlinkTarget(entryPath);
      if (!resolvedTarget) {
        return false;
      }
      let resolvedRealTarget: string;
      try {
        resolvedRealTarget = fs.realpathSync(resolvedTarget);
      } catch {
        return false;
      }
      if (!isWithinDir(realTargetDir, resolvedRealTarget)) {
        return false;
      }
      continue;
    }
    if (stat.isDirectory()) {
      if (!isLegacyTreeSymlinkMirror(entryPath, realTargetDir)) {
        return false;
      }
      continue;
    }
    return false;
  }

  return true;
}

function isLegacyDirSymlinkMirror(legacyDir: string, targetDir: string): boolean {
  let realTargetDir: string;
  try {
    realTargetDir = fs.realpathSync(targetDir);
  } catch {
    return false;
  }
  return isLegacyTreeSymlinkMirror(legacyDir, realTargetDir);
}

export async function autoMigrateLegacyStateDir(params: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}): Promise<StateDirMigrationResult> {
  if (autoMigrateStateDirChecked) {
    return { migrated: false, skipped: true, changes: [], warnings: [] };
  }
  autoMigrateStateDirChecked = true;

  const env = params.env ?? process.env;
  if (normalizeEnvPathOverride(env.OPENCLAW_STATE_DIR)) {
    return { migrated: false, skipped: true, changes: [], warnings: [] };
  }

  const homedir = params.homedir ?? os.homedir;
  const targetDir = resolveNewStateDir(homedir);
  const legacyDirs = resolveLegacyStateDirs(homedir);
  let legacyDir = legacyDirs.find((dir) => {
    try {
      return fs.existsSync(dir);
    } catch {
      return false;
    }
  });
  const warnings: string[] = [];
  const changes: string[] = [];

  let legacyStat: fs.Stats | null = null;
  try {
    legacyStat = legacyDir ? fs.lstatSync(legacyDir) : null;
  } catch {
    legacyStat = null;
  }
  if (!legacyStat) {
    return { migrated: false, skipped: false, changes, warnings };
  }
  if (!legacyStat.isDirectory() && !legacyStat.isSymbolicLink()) {
    warnings.push(`Legacy state path is not a directory: ${legacyDir}`);
    return { migrated: false, skipped: false, changes, warnings };
  }

  let symlinkDepth = 0;
  while (legacyStat.isSymbolicLink()) {
    const legacyTarget = legacyDir ? resolveSymlinkTarget(legacyDir) : null;
    if (!legacyTarget) {
      warnings.push(
        `Legacy state dir is a symlink (${legacyDir ?? "unknown"}); could not resolve target.`,
      );
      return { migrated: false, skipped: false, changes, warnings };
    }
    if (path.resolve(legacyTarget) === path.resolve(targetDir)) {
      return { migrated: false, skipped: false, changes, warnings };
    }
    if (legacyDirs.some((dir) => path.resolve(dir) === path.resolve(legacyTarget))) {
      legacyDir = legacyTarget;
      try {
        legacyStat = fs.lstatSync(legacyDir);
      } catch {
        legacyStat = null;
      }
      if (!legacyStat) {
        warnings.push(`Legacy state dir missing after symlink resolution: ${legacyDir}`);
        return { migrated: false, skipped: false, changes, warnings };
      }
      if (!legacyStat.isDirectory() && !legacyStat.isSymbolicLink()) {
        warnings.push(`Legacy state path is not a directory: ${legacyDir}`);
        return { migrated: false, skipped: false, changes, warnings };
      }
      symlinkDepth += 1;
      if (symlinkDepth > 2) {
        warnings.push(`Legacy state dir symlink chain too deep: ${legacyDir}`);
        return { migrated: false, skipped: false, changes, warnings };
      }
      continue;
    }
    warnings.push(
      `Legacy state dir is a symlink (${legacyDir ?? "unknown"} → ${legacyTarget}); skipping auto-migration.`,
    );
    return { migrated: false, skipped: false, changes, warnings };
  }

  if (isDirPath(targetDir)) {
    if (legacyDir && isLegacyDirSymlinkMirror(legacyDir, targetDir)) {
      return { migrated: false, skipped: false, changes, warnings };
    }
    warnings.push(
      `State dir migration skipped: target already exists (${targetDir}). Remove or merge manually.`,
    );
    return { migrated: false, skipped: false, changes, warnings };
  }

  try {
    if (!legacyDir) {
      throw new Error("Legacy state dir not found");
    }
    fs.renameSync(legacyDir, targetDir);
  } catch (err) {
    warnings.push(
      `Failed to move legacy state dir (${legacyDir ?? "unknown"} → ${targetDir}): ${String(err)}`,
    );
    return { migrated: false, skipped: false, changes, warnings };
  }

  try {
    if (!legacyDir) {
      throw new Error("Legacy state dir not found");
    }
    fs.symlinkSync(targetDir, legacyDir, "dir");
    changes.push(formatStateDirMigration(legacyDir, targetDir));
  } catch (err) {
    try {
      if (process.platform === "win32") {
        if (!legacyDir) {
          throw new Error("Legacy state dir not found", { cause: err });
        }
        fs.symlinkSync(targetDir, legacyDir, "junction");
        changes.push(formatStateDirMigration(legacyDir, targetDir));
      } else {
        throw err;
      }
    } catch (fallbackErr) {
      try {
        if (!legacyDir) {
          throw new Error("Legacy state dir not found", { cause: fallbackErr });
        }
        fs.renameSync(targetDir, legacyDir);
        warnings.push(
          `State dir migration rolled back (failed to link legacy path): ${String(fallbackErr)}`,
        );
        return { migrated: false, skipped: false, changes: [], warnings };
      } catch (rollbackErr) {
        warnings.push(
          `State dir moved but failed to link legacy path (${legacyDir ?? "unknown"} → ${targetDir}): ${String(fallbackErr)}`,
        );
        warnings.push(
          `Rollback failed; set OPENCLAW_STATE_DIR=${targetDir} to avoid split state: ${String(rollbackErr)}`,
        );
        changes.push(`State dir: ${legacyDir ?? "unknown"} → ${targetDir}`);
      }
    }
  }

  return { migrated: changes.length > 0, skipped: false, changes, warnings };
}

async function collectChannelLegacyStateMigrationPlans(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  oauthDir: string;
}): Promise<ChannelLegacyStateMigrationPlan[]> {
  const plans: ChannelLegacyStateMigrationPlan[] = collectCoreLegacyStateMigrationPlans({
    stateDir: params.stateDir,
    env: params.env,
    cfg: params.cfg,
  });
  // Legacy state detection belongs on a narrow setup-entry surface so doctor
  // does not cold-load unrelated runtime channel code.
  const detectors = listBundledChannelLegacyStateMigrationDetectors({ config: params.cfg });
  for (const detectLegacyStateMigrations of detectors) {
    const detected = await detectLegacyStateMigrations({
      cfg: params.cfg,
      env: params.env,
      stateDir: params.stateDir,
      oauthDir: params.oauthDir,
    });
    if (detected?.length) {
      plans.push(...detected);
    }
  }
  return plans;
}

export async function detectLegacyStateMigrations(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  includeSessions?: boolean;
  includeChannelPlans?: boolean;
}): Promise<LegacyStateDetection> {
  const env = params.env ?? process.env;
  const homedir = params.homedir ?? os.homedir;
  const includeSessions = params.includeSessions ?? true;
  const includeChannelPlans = params.includeChannelPlans ?? true;
  const stateDir = resolveStateDir(env, homedir);
  const oauthDir = resolveOAuthDir(env, stateDir);

  const targetAgentId = normalizeAgentId(resolveDefaultAgentId(params.cfg));
  const rawMainKey = params.cfg.session?.mainKey;
  const targetMainKey =
    typeof rawMainKey === "string" && rawMainKey.trim().length > 0
      ? rawMainKey.trim()
      : DEFAULT_MAIN_KEY;
  const targetScope = params.cfg.session?.scope;

  const sessionsLegacyDir = path.join(stateDir, "sessions");
  const sessionsLegacyStorePath = path.join(sessionsLegacyDir, "sessions.json");
  const sessionsTargetDir = path.join(stateDir, "agents", targetAgentId, "sessions");
  const sessionsTargetStorePath = path.join(sessionsTargetDir, "sessions.json");
  const hasTargetJsonSessionStore = includeSessions && fileExists(sessionsTargetStorePath);
  const legacySessionEntries = includeSessions ? safeReadDir(sessionsLegacyDir) : [];
  const hasLegacySessions =
    (includeSessions && fileExists(sessionsLegacyStorePath)) ||
    legacySessionEntries.some((e) => e.isFile() && e.name.endsWith(".jsonl"));

  const targetSessionParsed = hasTargetJsonSessionStore
    ? readSessionStoreJson5(sessionsTargetStorePath)
    : { store: {}, ok: true };
  const legacyKeys =
    includeSessions && targetSessionParsed.ok
      ? listLegacySessionKeys({
          store: targetSessionParsed.store,
          agentId: targetAgentId,
          mainKey: targetMainKey,
          scope: targetScope,
        })
      : [];

  const legacyAgentDir = path.join(stateDir, "agent");
  const targetAgentDir = path.join(stateDir, "agents", targetAgentId, "agent");
  const hasLegacyAgentDir = existsDir(legacyAgentDir);
  const channelPlans = includeChannelPlans
    ? await collectChannelLegacyStateMigrationPlans({
        cfg: params.cfg,
        env,
        stateDir,
        oauthDir,
      })
    : [];
  const sqliteLegacyTables = detectGlobalAgentOwnedSqliteLegacyTables(env);

  const preview: string[] = [];
  if (hasLegacySessions) {
    preview.push(`- Sessions: ${sessionsLegacyDir} → ${sessionsTargetDir}`);
  }
  if (legacyKeys.length > 0) {
    preview.push(`- Sessions: canonicalize legacy keys in ${sessionsTargetStorePath}`);
  }
  if (hasTargetJsonSessionStore) {
    preview.push(`- Sessions: import ${sessionsTargetStorePath} into SQLite`);
  }
  if (hasLegacyAgentDir) {
    preview.push(`- Agent dir: ${legacyAgentDir} → ${targetAgentDir}`);
  }
  if (channelPlans.length > 0) {
    preview.push(...channelPlans.map(buildLegacyMigrationPreview));
  }
  if (sqliteLegacyTables.length > 0) {
    preview.push(
      `- SQLite: move global agent-owned table(s) into per-agent databases: ${sqliteLegacyTables.join(", ")}`,
    );
  }

  return {
    targetAgentId,
    targetMainKey,
    targetScope,
    cfg: params.cfg,
    env,
    stateDir,
    oauthDir,
    sessions: {
      legacyDir: sessionsLegacyDir,
      legacyStorePath: sessionsLegacyStorePath,
      targetDir: sessionsTargetDir,
      targetStorePath: sessionsTargetStorePath,
      hasLegacy: hasLegacySessions || legacyKeys.length > 0 || hasTargetJsonSessionStore,
      legacyKeys,
    },
    agentDir: {
      legacyDir: legacyAgentDir,
      targetDir: targetAgentDir,
      hasLegacy: hasLegacyAgentDir,
    },
    channelPlans: {
      hasLegacy: channelPlans.length > 0,
      plans: channelPlans,
    },
    sqlite: {
      hasLegacy: sqliteLegacyTables.length > 0,
      legacyTables: sqliteLegacyTables,
    },
    preview,
  };
}

async function migrateLegacySessions(
  detected: LegacyStateDetection,
  now: () => number,
): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  if (!detected.sessions.hasLegacy) {
    return { changes, warnings };
  }

  ensureDir(detected.sessions.targetDir);

  const legacyParsed = fileExists(detected.sessions.legacyStorePath)
    ? readSessionStoreJson5(detected.sessions.legacyStorePath)
    : { store: {}, ok: true };
  const targetParsed = fileExists(detected.sessions.targetStorePath)
    ? readSessionStoreJson5(detected.sessions.targetStorePath)
    : { store: {}, ok: true };
  const hasTargetSessionStoreFile = fileExists(detected.sessions.targetStorePath);
  const legacyStore = legacyParsed.store;
  const targetStore = targetParsed.store;

  const canonicalizedTarget = canonicalizeSessionStore({
    store: targetStore,
    agentId: detected.targetAgentId,
    mainKey: detected.targetMainKey,
    scope: detected.targetScope,
  });
  const canonicalizedLegacy = canonicalizeSessionStore({
    store: legacyStore,
    agentId: detected.targetAgentId,
    mainKey: detected.targetMainKey,
    scope: detected.targetScope,
  });

  const merged: Record<string, SessionEntryLike> = { ...canonicalizedTarget.store };
  for (const [key, entry] of Object.entries(canonicalizedLegacy.store)) {
    merged[key] = mergeSessionEntry({
      existing: merged[key],
      incoming: entry,
      preferIncomingOnTie: false,
    });
  }

  const mainKey = buildAgentMainSessionKey({
    agentId: detected.targetAgentId,
    mainKey: detected.targetMainKey,
  });
  if (!merged[mainKey]) {
    const latest = pickLatestLegacyDirectEntry(legacyStore);
    if (latest?.sessionId) {
      merged[mainKey] = latest;
      changes.push(`Migrated latest direct-chat session → ${mainKey}`);
    }
  }

  if (!legacyParsed.ok) {
    warnings.push(
      `Legacy sessions store unreadable; left in place at ${detected.sessions.legacyStorePath}`,
    );
  }

  if (
    (legacyParsed.ok || targetParsed.ok) &&
    (Object.keys(legacyStore).length > 0 ||
      Object.keys(targetStore).length > 0 ||
      (hasTargetSessionStoreFile && targetParsed.ok))
  ) {
    const normalized: Record<string, SessionEntry> = {};
    for (const [key, entry] of Object.entries(merged)) {
      const normalizedEntry = normalizeSessionEntry(entry);
      if (!normalizedEntry) {
        continue;
      }
      normalized[key] = normalizedEntry;
    }
    const imported = mergeSqliteSessionEntries(
      {
        agentId: detected.targetAgentId,
        env: detected.env,
      },
      normalized,
    );
    changes.push(
      `Imported ${imported.imported} session index row(s) into SQLite for agent ${detected.targetAgentId}`,
    );
    if (targetParsed.ok && fileExists(detected.sessions.targetStorePath)) {
      try {
        fs.rmSync(detected.sessions.targetStorePath, { force: true });
      } catch {
        // ignore
      }
    }
    if (canonicalizedTarget.legacyKeys.length > 0) {
      changes.push(`Canonicalized ${canonicalizedTarget.legacyKeys.length} legacy session key(s)`);
    }
  }

  const entries = safeReadDir(detected.sessions.legacyDir);
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (entry.name === "sessions.json") {
      continue;
    }
    if (!entry.name.endsWith(".jsonl")) {
      continue;
    }
    const from = path.join(detected.sessions.legacyDir, entry.name);
    const to = path.join(detected.sessions.targetDir, entry.name);
    try {
      const imported = importLegacyTranscriptFileToSqlite({
        sourcePath: from,
        transcriptPath: to,
        agentId: detected.targetAgentId,
        env: detected.env,
      });
      fs.rmSync(from, { force: true });
      changes.push(
        `Imported ${entry.name} transcript (${imported.imported} event(s)) into SQLite for agent ${detected.targetAgentId}`,
      );
    } catch (err) {
      warnings.push(`Failed importing transcript ${from}: ${String(err)}`);
    }
  }

  const targetEntries = safeReadDir(detected.sessions.targetDir);
  for (const entry of targetEntries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }
    const transcriptPath = path.join(detected.sessions.targetDir, entry.name);
    try {
      const imported = importLegacyTranscriptFileToSqlite({
        sourcePath: transcriptPath,
        transcriptPath,
        agentId: detected.targetAgentId,
        env: detected.env,
      });
      fs.rmSync(transcriptPath, { force: true });
      changes.push(
        `Imported canonical ${entry.name} transcript (${imported.imported} event(s)) into SQLite for agent ${detected.targetAgentId}`,
      );
    } catch (err) {
      warnings.push(`Failed importing transcript ${transcriptPath}: ${String(err)}`);
    }
  }

  if (legacyParsed.ok) {
    try {
      if (fileExists(detected.sessions.legacyStorePath)) {
        fs.rmSync(detected.sessions.legacyStorePath, { force: true });
      }
    } catch {
      // ignore
    }
  }

  removeDirIfEmpty(detected.sessions.legacyDir);
  const legacyLeft = safeReadDir(detected.sessions.legacyDir).filter((e) => e.isFile());
  if (legacyLeft.length > 0) {
    const backupDir = `${detected.sessions.legacyDir}.legacy-${now()}`;
    try {
      fs.renameSync(detected.sessions.legacyDir, backupDir);
      warnings.push(`Left legacy sessions at ${backupDir}`);
    } catch {
      // ignore
    }
  }

  return { changes, warnings };
}

export async function migrateLegacyAgentDir(
  detected: LegacyStateDetection,
  now: () => number,
): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  if (!detected.agentDir.hasLegacy) {
    return { changes, warnings };
  }

  ensureDir(detected.agentDir.targetDir);

  const entries = safeReadDir(detected.agentDir.legacyDir);
  for (const entry of entries) {
    const from = path.join(detected.agentDir.legacyDir, entry.name);
    const to = path.join(detected.agentDir.targetDir, entry.name);
    if (fs.existsSync(to)) {
      continue;
    }
    try {
      fs.renameSync(from, to);
      changes.push(`Moved agent file ${entry.name} → agents/${detected.targetAgentId}/agent`);
    } catch (err) {
      warnings.push(`Failed moving ${from}: ${String(err)}`);
    }
  }

  removeDirIfEmpty(detected.agentDir.legacyDir);
  if (!emptyDirOrMissing(detected.agentDir.legacyDir)) {
    const backupDir = path.join(
      detected.stateDir,
      "agents",
      detected.targetAgentId,
      `agent.legacy-${now()}`,
    );
    try {
      fs.renameSync(detected.agentDir.legacyDir, backupDir);
      warnings.push(`Left legacy agent dir at ${backupDir}`);
    } catch (err) {
      warnings.push(`Failed relocating legacy agent dir: ${String(err)}`);
    }
  }

  return { changes, warnings };
}

async function migrateChannelLegacyStatePlans(
  detected: LegacyStateDetection,
): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  if (!detected.channelPlans.hasLegacy) {
    return { changes, warnings };
  }
  return await runLegacyMigrationPlans(detected, detected.channelPlans.plans);
}

function globalSqliteTableExists(params: {
  db: import("node:sqlite").DatabaseSync;
  name: GlobalAgentOwnedSqliteLegacyTable;
}) {
  const kysely = getNodeSqliteKysely<LegacyGlobalAgentOwnedMigrationDatabase>(params.db);
  const row = executeCompiledSqliteQuerySync<SqliteFoundRow>(
    params.db,
    sql`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ${params.name} LIMIT 1`.compile(
      kysely,
    ),
  ).rows[0];
  return row?.found !== undefined;
}

function groupRowsByAgentId<T extends { agent_id?: unknown }>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    if (typeof row.agent_id !== "string" || !row.agent_id.trim()) {
      continue;
    }
    const agentId = normalizeAgentId(row.agent_id);
    grouped.set(agentId, [...(grouped.get(agentId) ?? []), row]);
  }
  return grouped;
}

function migrateGlobalAgentOwnedSqliteTables(params: { env?: NodeJS.ProcessEnv }): {
  changes: string[];
  warnings: string[];
} {
  const changes: string[] = [];
  const warnings: string[] = [];
  const stateDatabase = openOpenClawStateDatabase({ env: params.env });
  const legacyKysely = getNodeSqliteKysely<LegacyGlobalAgentOwnedMigrationDatabase>(
    stateDatabase.db,
  );

  try {
    if (globalSqliteTableExists({ db: stateDatabase.db, name: "session_entries" })) {
      const rows = executeCompiledSqliteQuerySync<LegacyGlobalSessionEntryRow>(
        stateDatabase.db,
        sql`SELECT agent_id, session_key, entry_json, updated_at FROM session_entries`.compile(
          legacyKysely,
        ),
      ).rows;
      for (const [agentId, agentRows] of groupRowsByAgentId(rows)) {
        runOpenClawAgentWriteTransaction(
          (agentDatabase) => {
            const validRows = agentRows.flatMap((row) => {
              if (typeof row.session_key !== "string" || typeof row.entry_json !== "string") {
                return [];
              }
              return [
                {
                  session_key: row.session_key,
                  entry_json: row.entry_json,
                  updated_at: Number(row.updated_at ?? Date.now()),
                },
              ];
            });
            if (validRows.length === 0) {
              return;
            }
            const db = getNodeSqliteKysely<AgentSessionEntryMigrationDatabase>(agentDatabase.db);
            executeSqliteQuerySync(
              agentDatabase.db,
              db
                .insertInto("session_entries")
                .values(validRows)
                .onConflict((conflict) =>
                  conflict.column("session_key").doUpdateSet({
                    entry_json: (eb) => eb.ref("excluded.entry_json"),
                    updated_at: (eb) => eb.ref("excluded.updated_at"),
                  }),
                ),
            );
          },
          { agentId, env: params.env },
        );
      }
      stateDatabase.db.exec(
        "DROP INDEX IF EXISTS idx_session_entries_updated_at; DROP TABLE session_entries;",
      );
      if (rows.length > 0) {
        changes.push(
          `Migrated ${rows.length} global session row(s) into per-agent SQLite databases.`,
        );
      }
    }
  } catch (err) {
    warnings.push(`Failed migrating global session rows into per-agent databases: ${String(err)}`);
  }

  try {
    if (globalSqliteTableExists({ db: stateDatabase.db, name: "transcript_events" })) {
      const rows = executeCompiledSqliteQuerySync<LegacyGlobalTranscriptEventRow>(
        stateDatabase.db,
        sql`SELECT agent_id, session_id, seq, event_json, created_at FROM transcript_events`.compile(
          legacyKysely,
        ),
      ).rows;
      for (const [agentId, agentRows] of groupRowsByAgentId(rows)) {
        runOpenClawAgentWriteTransaction(
          (agentDatabase) => {
            const validRows = agentRows.flatMap((row) => {
              if (typeof row.session_id !== "string" || typeof row.event_json !== "string") {
                return [];
              }
              return [
                {
                  session_id: row.session_id,
                  seq: Number(row.seq ?? 0),
                  event_json: row.event_json,
                  created_at: Number(row.created_at ?? Date.now()),
                },
              ];
            });
            if (validRows.length === 0) {
              return;
            }
            const db = getNodeSqliteKysely<AgentTranscriptEventMigrationDatabase>(agentDatabase.db);
            executeSqliteQuerySync(
              agentDatabase.db,
              db
                .insertInto("transcript_events")
                .values(validRows)
                .onConflict((conflict) =>
                  conflict.columns(["session_id", "seq"]).doUpdateSet({
                    event_json: (eb) => eb.ref("excluded.event_json"),
                    created_at: (eb) => eb.ref("excluded.created_at"),
                  }),
                ),
            );
          },
          { agentId, env: params.env },
        );
      }
      stateDatabase.db.exec("DROP TABLE transcript_events;");
      if (rows.length > 0) {
        changes.push(
          `Migrated ${rows.length} global transcript event row(s) into per-agent SQLite databases.`,
        );
      }
    }
  } catch (err) {
    warnings.push(
      `Failed migrating global transcript event rows into per-agent databases: ${String(err)}`,
    );
  }

  try {
    if (globalSqliteTableExists({ db: stateDatabase.db, name: "vfs_entries" })) {
      const rows = executeCompiledSqliteQuerySync<LegacyGlobalVfsEntryRow>(
        stateDatabase.db,
        sql`SELECT agent_id, namespace, path, kind, content_blob, metadata_json, updated_at FROM vfs_entries`.compile(
          legacyKysely,
        ),
      ).rows;
      for (const [agentId, agentRows] of groupRowsByAgentId(rows)) {
        runOpenClawAgentWriteTransaction(
          (agentDatabase) => {
            const validRows = agentRows.flatMap((row) => {
              if (
                typeof row.namespace === "string" &&
                typeof row.path === "string" &&
                typeof row.kind === "string" &&
                typeof row.metadata_json === "string"
              ) {
                const contentBlob =
                  row.content_blob instanceof Uint8Array ? Buffer.from(row.content_blob) : null;
                return [
                  {
                    namespace: row.namespace,
                    path: row.path,
                    kind: row.kind,
                    content_blob: contentBlob,
                    metadata_json: row.metadata_json,
                    updated_at: Number(row.updated_at ?? Date.now()),
                  },
                ];
              }
              return [];
            });
            if (validRows.length === 0) {
              return;
            }
            const db = getNodeSqliteKysely<AgentVfsEntryMigrationDatabase>(agentDatabase.db);
            executeSqliteQuerySync(
              agentDatabase.db,
              db
                .insertInto("vfs_entries")
                .values(validRows)
                .onConflict((conflict) =>
                  conflict.columns(["namespace", "path"]).doUpdateSet({
                    kind: (eb) => eb.ref("excluded.kind"),
                    content_blob: (eb) => eb.ref("excluded.content_blob"),
                    metadata_json: (eb) => eb.ref("excluded.metadata_json"),
                    updated_at: (eb) => eb.ref("excluded.updated_at"),
                  }),
                ),
            );
          },
          { agentId, env: params.env },
        );
      }
      stateDatabase.db.exec(
        "DROP INDEX IF EXISTS idx_vfs_entries_namespace; DROP TABLE vfs_entries;",
      );
      if (rows.length > 0) {
        changes.push(`Migrated ${rows.length} global VFS row(s) into per-agent SQLite databases.`);
      }
    }
  } catch (err) {
    warnings.push(`Failed migrating global VFS rows into per-agent databases: ${String(err)}`);
  }

  try {
    if (globalSqliteTableExists({ db: stateDatabase.db, name: "tool_artifacts" })) {
      const rows = executeCompiledSqliteQuerySync<LegacyGlobalToolArtifactRow>(
        stateDatabase.db,
        sql`SELECT agent_id, run_id, artifact_id, kind, metadata_json, blob, created_at FROM tool_artifacts`.compile(
          legacyKysely,
        ),
      ).rows;
      for (const [agentId, agentRows] of groupRowsByAgentId(rows)) {
        runOpenClawAgentWriteTransaction(
          (agentDatabase) => {
            const validRows = agentRows.flatMap((row) => {
              if (
                typeof row.run_id === "string" &&
                typeof row.artifact_id === "string" &&
                typeof row.kind === "string" &&
                typeof row.metadata_json === "string"
              ) {
                const blob = row.blob instanceof Uint8Array ? Buffer.from(row.blob) : null;
                return [
                  {
                    run_id: row.run_id,
                    artifact_id: row.artifact_id,
                    kind: row.kind,
                    metadata_json: row.metadata_json,
                    blob,
                    created_at: Number(row.created_at ?? Date.now()),
                  },
                ];
              }
              return [];
            });
            if (validRows.length === 0) {
              return;
            }
            const db = getNodeSqliteKysely<AgentToolArtifactMigrationDatabase>(agentDatabase.db);
            executeSqliteQuerySync(
              agentDatabase.db,
              db
                .insertInto("tool_artifacts")
                .values(validRows)
                .onConflict((conflict) =>
                  conflict.columns(["run_id", "artifact_id"]).doUpdateSet({
                    kind: (eb) => eb.ref("excluded.kind"),
                    metadata_json: (eb) => eb.ref("excluded.metadata_json"),
                    blob: (eb) => eb.ref("excluded.blob"),
                    created_at: (eb) => eb.ref("excluded.created_at"),
                  }),
                ),
            );
          },
          { agentId, env: params.env },
        );
      }
      stateDatabase.db.exec("DROP TABLE tool_artifacts;");
      if (rows.length > 0) {
        changes.push(
          `Migrated ${rows.length} global tool artifact row(s) into per-agent SQLite databases.`,
        );
      }
    }
  } catch (err) {
    warnings.push(
      `Failed migrating global tool artifact rows into per-agent databases: ${String(err)}`,
    );
  }

  return { changes, warnings };
}

export async function runLegacyStateMigrations(params: {
  detected: LegacyStateDetection;
  now?: () => number;
  backupPath?: string;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const now = params.now ?? (() => Date.now());
  const detected = params.detected;
  const startedAt = now();
  const sources = collectLegacyMigrationSources(detected);
  try {
    const sessions = await migrateLegacySessions(detected, now);
    const agentDir = await migrateLegacyAgentDir(detected, now);
    const channelPlans = await migrateChannelLegacyStatePlans(detected);
    const globalAgentRows = migrateGlobalAgentOwnedSqliteTables({ env: detected.env });
    const result = {
      changes: [
        ...sessions.changes,
        ...agentDir.changes,
        ...channelPlans.changes,
        ...globalAgentRows.changes,
      ],
      warnings: [
        ...sessions.warnings,
        ...agentDir.warnings,
        ...channelPlans.warnings,
        ...globalAgentRows.warnings,
      ],
    };
    const finishedAt = now();
    const status = result.warnings.length > 0 ? "warning" : "completed";
    const runId = recordOpenClawStateMigrationRun({
      env: detected.env,
      startedAt,
      finishedAt,
      status,
      report: {
        kind: "legacy-state",
        targetAgentId: detected.targetAgentId,
        stateDir: detected.stateDir,
        backupPath: params.backupPath,
        sources,
        changes: result.changes,
        warnings: result.warnings,
      },
    });
    recordLegacyMigrationSources({
      env: detected.env,
      importedAt: finishedAt,
      runId,
      sources,
      status,
    });
    return result;
  } catch (error) {
    const finishedAt = now();
    const runId = recordOpenClawStateMigrationRun({
      env: detected.env,
      startedAt,
      finishedAt,
      status: "failed",
      report: {
        kind: "legacy-state",
        targetAgentId: detected.targetAgentId,
        stateDir: detected.stateDir,
        sources,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    recordLegacyMigrationSources({
      env: detected.env,
      importedAt: finishedAt,
      runId,
      sources,
      status: "failed",
    });
    throw error;
  }
}
