import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { asNullableRecord, asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { resolveRequiredHomeDir } from "./home-dir.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { currentConversationBindingRow as serializeCurrentConversationBindingRow } from "./outbound/current-conversation-binding-row.js";
import { normalizeConversationRef } from "./outbound/session-binding-normalization.js";
import type { SessionBindingRecord } from "./outbound/session-binding.types.js";
import { migrationFileExists } from "./state-migrations.fs.js";
import { archiveLegacyImportSource } from "./state-migrations.storage.js";
import type { LegacyStateDetection, MigrationMessages } from "./state-migrations.types.js";
import { normalizeVoiceWakeRoutingConfig } from "./voicewake-routing.js";

type LegacyVoiceWakeImportDatabase = Pick<OpenClawStateKyselyDatabase, "config_machine_state">;
type LegacyConfigHealthImportDatabase = Pick<OpenClawStateKyselyDatabase, "config_health_entries">;
type LegacyPluginBindingApprovalsImportDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "plugin_binding_approvals"
>;
type LegacyCurrentConversationBindingsImportDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "current_conversation_bindings"
>;

const VOICEWAKE_TRIGGERS_STATE_KEY = "voicewake.triggers";
const VOICEWAKE_ROUTING_STATE_KEY = "voicewake.routing";
const DEFAULT_VOICEWAKE_TRIGGERS = ["openclaw", "claude", "computer"];

export function resolveLegacyVoiceWakeTriggersPath(stateDir: string): string {
  return path.join(stateDir, "settings", "voicewake.json");
}

export function resolveLegacyVoiceWakeRoutingPath(stateDir: string): string {
  return path.join(stateDir, "settings", "voicewake-routing.json");
}

type LegacyJsonImportOutcome = {
  changes: string[];
  notices?: string[];
};

/** Import and archive legacy JSON only after its synchronous SQLite commit succeeds. */
export function migrateLegacyJsonState<Value>(params: {
  sourcePath: string;
  stateDir: string;
  label: string;
  normalize: (value: unknown) => Value;
  recoverableReadFailure?: (error: unknown) => string | undefined;
  shouldMigrate?: (value: Value) => boolean;
  migrate: (db: DatabaseSync, value: Value) => LegacyJsonImportOutcome;
  retire?: (params: { sourcePath: string; changes: string[]; warnings: string[] }) => void;
}): MigrationMessages {
  const changes: string[] = [];
  const warnings: string[] = [];
  if (!migrationFileExists(params.sourcePath)) {
    return { changes, warnings };
  }

  let value: Value;
  try {
    value = params.normalize(JSON.parse(fs.readFileSync(params.sourcePath, "utf8")) as unknown);
  } catch (err) {
    const advisory = params.recoverableReadFailure?.(err);
    if (advisory) {
      return { changes, warnings: [advisory], warningDisposition: "recoverable" };
    }
    warnings.push(`Failed reading legacy ${params.label} ${params.sourcePath}: ${String(err)}`);
    return { changes, warnings };
  }
  if (params.shouldMigrate && !params.shouldMigrate(value)) {
    return { changes, warnings };
  }

  let outcome: LegacyJsonImportOutcome;
  try {
    outcome = runOpenClawStateWriteTransaction(({ db }) => params.migrate(db, value), {
      env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir },
    });
  } catch (err) {
    warnings.push(`Failed migrating legacy ${params.label}: ${String(err)}`);
    return { changes, warnings };
  }

  // Publish results and retire the source only after COMMIT; a failed commit must remain retryable.
  changes.push(...outcome.changes);
  if (params.retire) {
    params.retire({ sourcePath: params.sourcePath, changes, warnings });
  } else {
    archiveLegacyImportSource({
      sourcePath: params.sourcePath,
      label: params.label,
      changes,
      warnings,
    });
  }
  return outcome.notices?.length
    ? { changes, warnings, notices: outcome.notices }
    : { changes, warnings };
}

function normalizeLegacyVoiceWakeTriggers(input: unknown): string[] {
  const rec = asRecord(input);
  const triggers = normalizeTrimmedStringList(rec.triggers);
  return triggers.length > 0 ? triggers : DEFAULT_VOICEWAKE_TRIGGERS;
}

function importLegacyVoiceWakeMachineState(
  database: DatabaseSync,
  key: string,
  value: unknown,
  outcome: {
    change: string;
    notice: string;
    matches: (current: unknown) => boolean;
  },
): LegacyJsonImportOutcome {
  const db = getNodeSqliteKysely<LegacyVoiceWakeImportDatabase>(database);
  const existing = executeSqliteQueryTakeFirstSync(
    database,
    db.selectFrom("config_machine_state").select("value_json").where("state_key", "=", key),
  );
  if (existing) {
    return {
      changes: [],
      ...(outcome.matches(JSON.parse(existing.value_json)) ? {} : { notices: [outcome.notice] }),
    };
  }
  executeSqliteQuerySync(
    database,
    db.insertInto("config_machine_state").values({
      state_key: key,
      value_json: JSON.stringify(value),
      updated_at_ms: Date.now(),
    }),
  );
  return { changes: [outcome.change] };
}

export function migrateLegacyVoiceWakeSettings(params: {
  detected: LegacyStateDetection["voiceWake"];
  stateDir: string;
}): MigrationMessages {
  const triggerMigration = migrateLegacyJsonState({
    sourcePath: params.detected.triggersPath,
    stateDir: params.stateDir,
    label: "voice wake triggers",
    normalize: normalizeLegacyVoiceWakeTriggers,
    migrate(db, triggers) {
      return importLegacyVoiceWakeMachineState(db, VOICEWAKE_TRIGGERS_STATE_KEY, triggers, {
        change: `Migrated ${triggers.length} voice wake ${triggers.length === 1 ? "trigger" : "triggers"} → shared SQLite state`,
        notice: `Kept shared SQLite voice wake triggers because legacy file differs: ${params.detected.triggersPath}`,
        matches: (current) => JSON.stringify(current) === JSON.stringify(triggers),
      });
    },
  });

  const routingMigration = migrateLegacyJsonState({
    sourcePath: params.detected.routingPath,
    stateDir: params.stateDir,
    label: "voice wake routing",
    normalize: normalizeVoiceWakeRoutingConfig,
    migrate(db, routingConfig) {
      return importLegacyVoiceWakeMachineState(
        db,
        VOICEWAKE_ROUTING_STATE_KEY,
        { ...routingConfig, updatedAtMs: Date.now() },
        {
          change: `Migrated voice wake routing config with ${routingConfig.routes.length} ${routingConfig.routes.length === 1 ? "route" : "routes"} → shared SQLite state`,
          notice: `Kept shared SQLite voice wake routing because legacy file differs: ${params.detected.routingPath}`,
          matches(current) {
            const existing = normalizeVoiceWakeRoutingConfig(current);
            return (
              JSON.stringify(existing.defaultTarget) ===
                JSON.stringify(routingConfig.defaultTarget) &&
              JSON.stringify(existing.routes) === JSON.stringify(routingConfig.routes)
            );
          },
        },
      );
    },
  });

  const changes = [...triggerMigration.changes, ...routingMigration.changes];
  const warnings = [...triggerMigration.warnings, ...routingMigration.warnings];
  const notices = [...(triggerMigration.notices ?? []), ...(routingMigration.notices ?? [])];
  return notices.length > 0 ? { changes, warnings, notices } : { changes, warnings };
}

type LegacyConfigHealthEntry = {
  configPath: string;
  lastKnownGoodJson: string | null;
  lastPromotedGoodJson: string | null;
  lastObservedSuspiciousSignature: string | null;
};

export function resolveLegacyConfigHealthPath(stateDir: string): string {
  return path.join(stateDir, "logs", "config-health.json");
}

function normalizeLegacyConfigHealthEntry(
  configPath: string,
  input: unknown,
): LegacyConfigHealthEntry | null {
  const entry = asNullableRecord(input);
  if (!configPath.trim() || !entry) {
    return null;
  }
  const lastKnownGoodJson =
    entry.lastKnownGood && typeof entry.lastKnownGood === "object"
      ? JSON.stringify(entry.lastKnownGood)
      : null;
  const lastPromotedGoodJson =
    entry.lastPromotedGood && typeof entry.lastPromotedGood === "object"
      ? JSON.stringify(entry.lastPromotedGood)
      : null;
  const lastObservedSuspiciousSignature =
    typeof entry.lastObservedSuspiciousSignature === "string"
      ? entry.lastObservedSuspiciousSignature
      : null;
  if (!lastKnownGoodJson && !lastPromotedGoodJson && !lastObservedSuspiciousSignature) {
    return null;
  }
  return {
    configPath,
    lastKnownGoodJson,
    lastPromotedGoodJson,
    lastObservedSuspiciousSignature,
  };
}

function normalizeLegacyConfigHealthFile(input: unknown): LegacyConfigHealthEntry[] {
  const entries = asNullableRecord(asRecord(input).entries);
  if (!entries) {
    return [];
  }
  return Object.entries(entries)
    .flatMap(([configPath, entry]) => {
      const normalized = normalizeLegacyConfigHealthEntry(configPath, entry);
      return normalized ? [normalized] : [];
    })
    .toSorted((a, b) => a.configPath.localeCompare(b.configPath));
}

function configHealthRow(entry: LegacyConfigHealthEntry) {
  return {
    config_path: entry.configPath,
    last_known_good_json: entry.lastKnownGoodJson,
    last_promoted_good_json: entry.lastPromotedGoodJson,
    last_observed_suspicious_signature: entry.lastObservedSuspiciousSignature,
    updated_at_ms: Date.now(),
  };
}

function retireLegacyConfigHealthSource(params: {
  sourcePath: string;
  changes: string[];
  warnings: string[];
}): void {
  const archivedPath = `${params.sourcePath}.migrated`;
  if (!migrationFileExists(archivedPath)) {
    archiveLegacyImportSource({
      sourcePath: params.sourcePath,
      label: "config health state",
      changes: params.changes,
      warnings: params.warnings,
    });
    return;
  }

  // Released macOS builds can recreate this source after it was archived.
  // Once reconciled into SQLite, retaining it causes every run to warn again.
  try {
    fs.rmSync(params.sourcePath, { force: true });
    params.changes.push("Removed regenerated config health legacy source");
  } catch (err) {
    params.warnings.push(`Failed removing regenerated config health legacy source: ${String(err)}`);
  }
}

export function migrateLegacyConfigHealth(params: {
  detected: LegacyStateDetection["configHealth"];
  stateDir: string;
}): { changes: string[]; warnings: string[] } {
  return migrateLegacyJsonState({
    sourcePath: params.detected.sourcePath,
    stateDir: params.stateDir,
    label: "config health state",
    normalize: normalizeLegacyConfigHealthFile,
    retire: retireLegacyConfigHealthSource,
    migrate(db, entries) {
      const stateDb = getNodeSqliteKysely<LegacyConfigHealthImportDatabase>(db);
      const existing = executeSqliteQuerySync(
        db,
        stateDb
          .selectFrom("config_health_entries")
          .select([
            "config_path",
            "last_known_good_json",
            "last_promoted_good_json",
            "last_observed_suspicious_signature",
          ]),
      ).rows;
      const existingByPath = new Map(existing.map((row) => [row.config_path, row] as const));
      const entriesToInsert: LegacyConfigHealthEntry[] = [];
      let reconciledCount = 0;
      for (const entry of entries) {
        const existingEntry = existingByPath.get(entry.configPath);
        if (!existingEntry) {
          entriesToInsert.push(entry);
          continue;
        }

        const lastKnownGoodJson = existingEntry.last_known_good_json ?? entry.lastKnownGoodJson;
        const lastPromotedGoodJson =
          existingEntry.last_promoted_good_json ?? entry.lastPromotedGoodJson;
        if (
          lastKnownGoodJson === existingEntry.last_known_good_json &&
          lastPromotedGoodJson === existingEntry.last_promoted_good_json
        ) {
          continue;
        }
        executeSqliteQuerySync(
          db,
          stateDb
            .updateTable("config_health_entries")
            .set({
              last_known_good_json: lastKnownGoodJson,
              last_promoted_good_json: lastPromotedGoodJson,
              updated_at_ms: Date.now(),
            })
            .where("config_path", "=", entry.configPath),
        );
        reconciledCount += 1;
      }
      if (entriesToInsert.length > 0) {
        executeSqliteQuerySync(
          db,
          stateDb.insertInto("config_health_entries").values(entriesToInsert.map(configHealthRow)),
        );
      }
      const changes: string[] = [];
      if (entriesToInsert.length > 0) {
        changes.push(
          `Migrated ${entriesToInsert.length} config health ${entriesToInsert.length === 1 ? "entry" : "entries"} → shared SQLite state`,
        );
      }
      if (reconciledCount > 0) {
        changes.push(
          `Reconciled ${reconciledCount} config health ${reconciledCount === 1 ? "entry" : "entries"} → shared SQLite state`,
        );
      }
      return { changes };
    },
  });
}

type LegacyPluginBindingApprovalEntry = {
  pluginRoot: string;
  pluginId: string;
  pluginName?: string;
  channel: string;
  accountId: string;
  approvedAt: number;
};

export function resolveLegacyPluginBindingApprovalsPath(
  env: NodeJS.ProcessEnv,
  homedir: () => string,
): string {
  return path.join(
    resolveRequiredHomeDir(env, homedir),
    ".openclaw",
    "plugin-binding-approvals.json",
  );
}

function pluginBindingApprovalScopeKey(entry: {
  pluginRoot: string;
  channel: string;
  accountId: string;
}): string {
  return [entry.pluginRoot, normalizeLowercaseStringOrEmpty(entry.channel), entry.accountId].join(
    "::",
  );
}

function normalizeLegacyPluginBindingApprovalEntry(
  input: unknown,
): LegacyPluginBindingApprovalEntry | null {
  const entry = asRecord(input);
  const pluginRoot = normalizeOptionalString(entry.pluginRoot);
  const pluginId = normalizeOptionalString(entry.pluginId);
  const channel = normalizeLowercaseStringOrEmpty(entry.channel);
  const accountId = normalizeOptionalString(entry.accountId) ?? "default";
  if (!pluginRoot || !pluginId || !channel) {
    return null;
  }
  return {
    pluginRoot,
    pluginId,
    pluginName: typeof entry.pluginName === "string" ? entry.pluginName : undefined,
    channel,
    accountId,
    approvedAt:
      typeof entry.approvedAt === "number" && Number.isFinite(entry.approvedAt)
        ? Math.floor(entry.approvedAt)
        : Date.now(),
  };
}

function normalizeLegacyPluginBindingApprovalsFile(
  input: unknown,
): LegacyPluginBindingApprovalEntry[] {
  const file = asRecord(input);
  if (file.version !== 1 || !Array.isArray(file.approvals)) {
    return [];
  }
  const approvals = new Map<string, LegacyPluginBindingApprovalEntry>();
  for (const item of file.approvals) {
    const entry = normalizeLegacyPluginBindingApprovalEntry(item);
    if (!entry) {
      continue;
    }
    approvals.set(pluginBindingApprovalScopeKey(entry), entry);
  }
  return [...approvals.values()].toSorted((a, b) =>
    pluginBindingApprovalScopeKey(a).localeCompare(pluginBindingApprovalScopeKey(b)),
  );
}

function pluginBindingApprovalRow(entry: LegacyPluginBindingApprovalEntry) {
  return {
    plugin_root: entry.pluginRoot,
    channel: entry.channel,
    account_id: entry.accountId,
    plugin_id: entry.pluginId,
    plugin_name: entry.pluginName ?? null,
    approved_at: entry.approvedAt,
  };
}

function importMissingLegacyBindings<Entry>(params: {
  entries: Entry[];
  existingByKey: ReadonlyMap<string, string>;
  key: (entry: Entry) => string;
  json: (entry: Entry) => string;
  insert: (entries: Entry[]) => void;
  migrated: (count: number) => string;
  conflicts: (count: number) => string;
}): LegacyJsonImportOutcome {
  const toInsert: Entry[] = [];
  let conflictCount = 0;
  for (const entry of params.entries) {
    const existingJson = params.existingByKey.get(params.key(entry));
    if (existingJson === undefined) {
      toInsert.push(entry);
    } else if (existingJson !== params.json(entry)) {
      conflictCount += 1;
    }
  }
  if (toInsert.length > 0) {
    params.insert(toInsert);
  }
  return {
    changes: toInsert.length > 0 ? [params.migrated(toInsert.length)] : [],
    ...(conflictCount > 0 ? { notices: [params.conflicts(conflictCount)] } : {}),
  };
}

export function migrateLegacyPluginBindingApprovals(params: {
  detected: LegacyStateDetection["pluginBindingApprovals"];
  stateDir: string;
}): MigrationMessages {
  // Detection requires the source to belong to this state root; migrationFileExists
  // re-checks for races before the import mutates the same trust scope.
  if (!params.detected.hasLegacy) {
    return { changes: [], warnings: [] };
  }
  return migrateLegacyJsonState({
    sourcePath: params.detected.sourcePath,
    stateDir: params.stateDir,
    label: "plugin binding approvals",
    normalize: normalizeLegacyPluginBindingApprovalsFile,
    migrate(db, approvals) {
      const stateDb = getNodeSqliteKysely<LegacyPluginBindingApprovalsImportDatabase>(db);
      const existing = executeSqliteQuerySync(
        db,
        stateDb
          .selectFrom("plugin_binding_approvals")
          .select([
            "plugin_root",
            "channel",
            "account_id",
            "plugin_id",
            "plugin_name",
            "approved_at",
          ]),
      ).rows;
      const existingByKey = new Map(
        existing.map(
          (row) =>
            [
              pluginBindingApprovalScopeKey({
                pluginRoot: row.plugin_root,
                channel: row.channel,
                accountId: row.account_id,
              }),
              JSON.stringify(row),
            ] as const,
        ),
      );
      return importMissingLegacyBindings({
        entries: approvals,
        existingByKey,
        key: pluginBindingApprovalScopeKey,
        json: (approval) => JSON.stringify(pluginBindingApprovalRow(approval)),
        insert(approvalsToInsert) {
          executeSqliteQuerySync(
            db,
            stateDb
              .insertInto("plugin_binding_approvals")
              .values(approvalsToInsert.map(pluginBindingApprovalRow)),
          );
        },
        migrated: (count) =>
          `Migrated ${count} plugin binding ${count === 1 ? "approval" : "approvals"} → shared SQLite state`,
        conflicts: (count) =>
          `Kept shared SQLite plugin binding approvals because ${count} ${count === 1 ? "legacy approval conflicts" : "legacy approvals conflict"}: ${params.detected.sourcePath}`,
      });
    },
  });
}

export function resolveLegacyCurrentConversationBindingsPath(stateDir: string): string {
  return path.join(stateDir, "bindings", "current-conversations.json");
}

function currentConversationBindingKey(ref: SessionBindingRecord["conversation"]): string {
  const normalized = normalizeConversationRef(ref);
  return [
    normalized.channel,
    normalized.accountId,
    normalized.parentConversationId ?? "",
    normalized.conversationId,
  ].join("\u241f");
}

function normalizeLegacyCurrentConversationBindingRecord(
  input: unknown,
): SessionBindingRecord | null {
  const record = input && typeof input === "object" ? (input as Partial<SessionBindingRecord>) : {};
  if (!record.conversation?.conversationId) {
    return null;
  }
  const conversation = normalizeConversationRef(record.conversation);
  const targetSessionKey = normalizeOptionalString(record.targetSessionKey);
  if (!targetSessionKey) {
    return null;
  }
  const targetKind = record.targetKind === "subagent" ? "subagent" : "session";
  const status = record.status === "ending" || record.status === "ended" ? record.status : "active";
  const boundAt =
    typeof record.boundAt === "number" && Number.isFinite(record.boundAt)
      ? Math.floor(record.boundAt)
      : Date.now();
  const expiresAt =
    typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt)
      ? Math.floor(record.expiresAt)
      : undefined;
  return {
    bindingId: `generic:${currentConversationBindingKey(conversation)}`,
    targetSessionKey,
    targetKind,
    conversation,
    status,
    boundAt,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
      ? { metadata: record.metadata }
      : {}),
  };
}

function normalizeLegacyCurrentConversationBindingFile(input: unknown): SessionBindingRecord[] {
  const file = asRecord(input);
  if (file.version !== 1 || !Array.isArray(file.bindings)) {
    return [];
  }
  const records = new Map<string, SessionBindingRecord>();
  for (const item of file.bindings) {
    const record = normalizeLegacyCurrentConversationBindingRecord(item);
    if (!record) {
      continue;
    }
    records.set(currentConversationBindingKey(record.conversation), record);
  }
  return [...records.values()].toSorted((a, b) => a.bindingId.localeCompare(b.bindingId));
}

function currentConversationBindingRow(
  record: SessionBindingRecord,
): ReturnType<typeof serializeCurrentConversationBindingRow> {
  const conversation = normalizeConversationRef(record.conversation);
  return serializeCurrentConversationBindingRow(
    record,
    conversation,
    currentConversationBindingKey(conversation),
  );
}

export function migrateLegacyCurrentConversationBindings(params: {
  detected: LegacyStateDetection["currentConversationBindings"];
  stateDir: string;
}): MigrationMessages {
  return migrateLegacyJsonState({
    sourcePath: params.detected.sourcePath,
    stateDir: params.stateDir,
    label: "current-conversation bindings",
    normalize: normalizeLegacyCurrentConversationBindingFile,
    migrate(db, records) {
      const stateDb = getNodeSqliteKysely<LegacyCurrentConversationBindingsImportDatabase>(db);
      const existing = executeSqliteQuerySync(
        db,
        stateDb.selectFrom("current_conversation_bindings").select(["binding_key", "record_json"]),
      ).rows;
      const existingByKey = new Map(
        existing.map((row) => [row.binding_key, row.record_json] as const),
      );
      return importMissingLegacyBindings({
        entries: records,
        existingByKey,
        key: (record) => currentConversationBindingKey(record.conversation),
        json: (record) => JSON.stringify(record),
        insert(recordsToInsert) {
          executeSqliteQuerySync(
            db,
            stateDb
              .insertInto("current_conversation_bindings")
              .values(recordsToInsert.map(currentConversationBindingRow)),
          );
        },
        migrated: (count) =>
          `Migrated ${count} current-conversation ${count === 1 ? "binding" : "bindings"} → shared SQLite state`,
        conflicts: (count) =>
          `Kept shared SQLite current-conversation bindings because ${count} ${count === 1 ? "legacy binding conflicts" : "legacy bindings conflict"}: ${params.detected.sourcePath}`,
      });
    },
  });
}
