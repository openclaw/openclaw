import { isDeepStrictEqual } from "node:util";
import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  getPluginInstallRecordMapEntry,
  parsePluginInstallRecordMap,
} from "../config/plugin-install-record-map.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { DEFERRED_PLUGIN_MIGRATION_RUN_PREFIX } from "./deferred-plugin-migrations.contract.js";
import {
  PluginCohortMigrationRowSchema,
  type PluginCohortMigrationPublication,
  type PluginCohortRecovery,
} from "./update-plugin-cohort-schema.js";

type RecordChange = Extract<
  PluginCohortRecovery["publications"][number],
  { kind: "records" }
>["records"][number];

export function foldPluginCohortRecordPublications(
  publications: PluginCohortRecovery["publications"],
): ReadonlyMap<string, RecordChange> {
  const changes = new Map<string, RecordChange>();
  for (const publication of publications) {
    if (publication.kind !== "records") {
      continue;
    }
    for (const change of publication.records) {
      const previous = changes.get(change.pluginId);
      if (previous && !isDeepStrictEqual(previous.after, change.before)) {
        throw new Error(
          `Plugin ${change.pluginId} changed between update publications; cohort recovery preserved it.`,
        );
      }
      changes.set(change.pluginId, {
        ...change,
        before: previous ? previous.before : change.before,
      });
    }
  }
  return changes;
}

function readInstallRecords(raw: string | undefined): Record<string, PluginInstallRecord> {
  if (raw === undefined) {
    return {};
  }
  const value: unknown = safeParseJson(raw);
  const records =
    isRecord(value) && isRecord(value.index)
      ? parsePluginInstallRecordMap(value.index.installRecords)
      : null;
  if (!records) {
    throw new Error("Database rollback cannot compare invalid canonical plugin install records.");
  }
  return records;
}

/** Doctor generation receipts can include outside writes; the backup must not erase those plugins. */
export function assertPluginCohortDatabaseRestoreRecords(
  publications: PluginCohortRecovery["publications"],
  baselineRaw: string | undefined,
  currentRaw: string | undefined,
): void {
  const baseline = readInstallRecords(baselineRaw);
  const current = readInstallRecords(currentRaw);
  const changes = foldPluginCohortRecordPublications(publications);
  const ids = new Set([...Object.keys(baseline), ...Object.keys(current), ...changes.keys()]);
  for (const pluginId of ids) {
    const before = getPluginInstallRecordMapEntry(baseline, pluginId);
    const retained = getPluginInstallRecordMapEntry(current, pluginId);
    const change = changes.get(pluginId);
    if (change && !isDeepStrictEqual(before, change.before)) {
      throw new Error(`Plugin ${pluginId} has no matching database backup preimage.`);
    }
    if (
      !isDeepStrictEqual(retained, before) &&
      !(change && isDeepStrictEqual(retained, change.after))
    ) {
      throw new Error(
        `Plugin ${pluginId} changed outside the update; database rollback preserved it.`,
      );
    }
  }
}

/** Repeated publications retain one original preimage and reject discontinuities. */
export function foldPluginCohortMigrationPublications(
  publications: readonly PluginCohortMigrationPublication[],
): ReadonlyMap<string, PluginCohortMigrationPublication["rows"][number]> {
  const rows = new Map<string, PluginCohortMigrationPublication["rows"][number]>();
  for (const publication of publications) {
    for (const row of publication.rows) {
      const previous = rows.get(row.pluginId);
      if (previous && !isDeepStrictEqual(previous.after, row.before)) {
        throw new Error(
          `Plugin migration obligation changed between update publications: ${row.pluginId}. Recovery preserved the decisions.`,
        );
      }
      rows.set(row.pluginId, { ...row, before: previous ? previous.before : row.before });
    }
  }
  return rows;
}

export type PluginCohortDatabaseMigrationRow = {
  id: string;
  started_at: number;
  finished_at: number | null;
  status: string;
  report_json: string;
};

function readMigrationRows(rows: readonly PluginCohortDatabaseMigrationRow[]) {
  return new Map(
    rows.map((row) => [
      row.id.slice(DEFERRED_PLUGIN_MIGRATION_RUN_PREFIX.length),
      PluginCohortMigrationRowSchema.parse({
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        status: row.status,
        reportJson: row.report_json,
      }),
    ]),
  );
}

/** Compare before physical replacement: compensation cannot observe a decision the backup erased. */
export function assertPluginCohortDatabaseRestoreMigrations(
  publications: PluginCohortRecovery["publications"],
  baselineRows: readonly PluginCohortDatabaseMigrationRow[],
  currentRows: readonly PluginCohortDatabaseMigrationRow[],
): void {
  const baseline = readMigrationRows(baselineRows);
  const current = readMigrationRows(currentRows);
  const changes = foldPluginCohortMigrationPublications(
    publications.filter((publication) => publication.kind === "plugin-migrations"),
  );
  const ids = new Set([...baseline.keys(), ...current.keys(), ...changes.keys()]);
  for (const pluginId of ids) {
    const before = baseline.get(pluginId);
    const retained = current.get(pluginId);
    const change = changes.get(pluginId);
    if (change && !isDeepStrictEqual(before, change.before)) {
      throw new Error(`Plugin migration ${pluginId} has no matching database backup preimage.`);
    }
    if (
      !isDeepStrictEqual(retained, before) &&
      !(change && isDeepStrictEqual(retained, change.after))
    ) {
      throw new Error(
        `Plugin migration ${pluginId} changed outside the update; database rollback preserved the later decision.`,
      );
    }
  }
}
