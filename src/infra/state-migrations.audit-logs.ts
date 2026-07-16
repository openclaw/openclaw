// Doctor-only import for retired core JSONL audit stores.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  CONFIG_AUDIT_MAX_ENTRIES,
  CONFIG_AUDIT_SCOPE,
  sanitizeConfigAuditRecord,
  type ConfigAuditRecord,
} from "../config/io.audit.js";
import { redactSecrets } from "../logging/redact.js";
import {
  SYSTEM_AGENT_AUDIT_MAX_ENTRIES,
  SYSTEM_AGENT_AUDIT_SCOPE,
  type SystemAgentAuditEntry,
} from "../system-agent/audit.js";
import { createSqliteAuditRecordStore } from "./sqlite-audit-record-store.js";
import { archiveLegacyImportSource } from "./state-migrations.storage.js";
import type { LegacyStateDetection, MigrationMessages } from "./state-migrations.types.js";

export type LegacyAuditLogSource = {
  kind: "config" | "system-agent" | "crestodian";
  label: string;
  sourcePath: string;
};

export type LegacyAuditLogsDetection = {
  sources: LegacyAuditLogSource[];
  hasLegacy: boolean;
};

type PreparedAuditRecord = {
  key: string;
  value: ConfigAuditRecord | SystemAgentAuditEntry;
  createdAt: number;
};

function legacyAuditRecordCreatedAt(
  source: LegacyAuditLogSource,
  value: ConfigAuditRecord | SystemAgentAuditEntry,
): number {
  const timestamp =
    source.kind === "config"
      ? (value as Partial<ConfigAuditRecord>).ts
      : (value as Partial<SystemAgentAuditEntry>).timestamp;
  if (typeof timestamp !== "string") {
    return 0;
  }
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function detectLegacyAuditLogs(params: {
  stateDir: string;
  doctorOnlyStateMigrations?: boolean;
}): LegacyAuditLogsDetection {
  const candidates: LegacyAuditLogSource[] = [
    {
      kind: "config",
      label: "config audit log",
      sourcePath: path.join(params.stateDir, "logs", "config-audit.jsonl"),
    },
    {
      kind: "system-agent",
      label: "system-agent audit log",
      sourcePath: path.join(params.stateDir, "audit", "system-agent.jsonl"),
    },
    {
      kind: "crestodian",
      label: "Crestodian audit log",
      sourcePath: path.join(params.stateDir, "audit", "crestodian.jsonl"),
    },
  ];
  // Intentionally invisible to automatic startup migration. That caller migrates every
  // detected source; these audit imports belong only to explicit `doctor --fix` repair.
  const sources =
    params.doctorOnlyStateMigrations === true
      ? candidates.filter((source) => fs.existsSync(source.sourcePath))
      : [];
  return { sources, hasLegacy: sources.length > 0 };
}

function prepareLegacyAuditRecords(source: LegacyAuditLogSource): {
  records: PreparedAuditRecord[];
  warnings: string[];
} {
  const records: PreparedAuditRecord[] = [];
  const warnings: string[] = [];
  const raw = fs.readFileSync(source.sourcePath, "utf8");
  for (const [index, line] of raw.split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch (error) {
      warnings.push(
        `Failed reading ${source.label} record at ${source.sourcePath}:${index + 1}: ${String(error)}`,
      );
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      warnings.push(
        `Skipped non-object ${source.label} record at ${source.sourcePath}:${index + 1}`,
      );
      continue;
    }
    const value =
      source.kind === "config"
        ? sanitizeConfigAuditRecord(parsed as ConfigAuditRecord)
        : (redactSecrets(parsed) as SystemAgentAuditEntry);
    const digest = createHash("sha256").update(trimmed).digest("hex").slice(0, 16);
    records.push({
      key: `legacy:${source.kind}:${index + 1}:${digest}`,
      value,
      createdAt: legacyAuditRecordCreatedAt(source, value),
    });
  }
  return { records, warnings };
}

function migrateLegacyAuditLogSource(params: {
  source: LegacyAuditLogSource;
  stateDir: string;
}): MigrationMessages {
  const changes: string[] = [];
  const prepared = prepareLegacyAuditRecords(params.source);
  const warnings = [...prepared.warnings];
  if (warnings.length > 0) {
    return { changes, warnings };
  }
  const env = { ...process.env, OPENCLAW_STATE_DIR: params.stateDir };
  const maxEntries =
    params.source.kind === "config" ? CONFIG_AUDIT_MAX_ENTRIES : SYSTEM_AGENT_AUDIT_MAX_ENTRIES;
  const store = createSqliteAuditRecordStore<ConfigAuditRecord | SystemAgentAuditEntry>({
    scope: params.source.kind === "config" ? CONFIG_AUDIT_SCOPE : SYSTEM_AGENT_AUDIT_SCOPE,
    maxEntries,
    env,
  });
  const existingKeys = new Set(store.entries().map((entry) => entry.key));
  const missing = prepared.records.filter((record) => !existingKeys.has(record.key));
  if (missing.length > maxEntries - store.size()) {
    warnings.push(
      `Skipped ${params.source.label} migration because SQLite has room for ${maxEntries - store.size()} of ${missing.length} missing rows; left legacy source in place`,
    );
    return { changes, warnings };
  }
  for (const record of missing) {
    store.register(record.key, record.value, record.createdAt);
  }
  const importedKeys = new Set(store.entries().map((entry) => entry.key));
  const missingKey = prepared.records.find((record) => !importedKeys.has(record.key))?.key;
  if (missingKey) {
    warnings.push(`SQLite verification missed ${params.source.label} row ${missingKey}`);
    return { changes, warnings };
  }
  changes.push(
    `Migrated ${params.source.label} -> shared SQLite state (${missing.length} new row(s))`,
  );
  archiveLegacyImportSource({
    sourcePath: params.source.sourcePath,
    label: params.source.label,
    changes,
    warnings,
  });
  return { changes, warnings };
}

export function migrateLegacyAuditLogs(params: {
  detected: LegacyStateDetection["auditLogs"];
  stateDir: string;
}): MigrationMessages {
  const changes: string[] = [];
  const warnings: string[] = [];
  for (const source of params.detected.sources) {
    try {
      const result = migrateLegacyAuditLogSource({ source, stateDir: params.stateDir });
      changes.push(...result.changes);
      warnings.push(...result.warnings);
    } catch (error) {
      warnings.push(`Failed migrating ${source.label}: ${String(error)}`);
    }
  }
  return { changes, warnings };
}
