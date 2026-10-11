import fs from "node:fs";
import path from "node:path";
import { asNullableRecord, asRecord } from "@openclaw/normalization-core/record-coerce";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { migrationFileExists } from "./state-migrations.fs.js";
import { archiveLegacyImportSource } from "./state-migrations.storage.js";
import type { LegacyStateDetection } from "./state-migrations.types.js";

type LegacyConfigHealthImportDatabase = Pick<OpenClawStateKyselyDatabase, "config_health_entries">;

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
  const { sourcePath } = params.detected;
  const warnings: string[] = [];
  if (!migrationFileExists(sourcePath)) {
    return { changes: [], warnings };
  }
  let entries: LegacyConfigHealthEntry[];
  try {
    entries = normalizeLegacyConfigHealthFile(JSON.parse(fs.readFileSync(sourcePath, "utf8")));
  } catch (error) {
    return {
      changes: [],
      warnings: [`Failed reading legacy config health state ${sourcePath}: ${String(error)}`],
    };
  }
  let changes: string[];
  try {
    changes = runOpenClawStateWriteTransaction(
      ({ db }) => {
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
            stateDb
              .insertInto("config_health_entries")
              .values(entriesToInsert.map(configHealthRow)),
          );
        }
        return [
          { action: "Migrated", count: entriesToInsert.length },
          { action: "Reconciled", count: reconciledCount },
        ].flatMap(({ action, count }) =>
          count > 0
            ? [
                `${action} ${count} config health ${count === 1 ? "entry" : "entries"} → shared SQLite state`,
              ]
            : [],
        );
      },
      { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } },
    );
  } catch (error) {
    return {
      changes: [],
      warnings: [`Failed migrating legacy config health state: ${String(error)}`],
    };
  }
  // Retire only after COMMIT so a failed transaction remains retryable.
  retireLegacyConfigHealthSource({ sourcePath, changes, warnings });
  return { changes, warnings };
}
