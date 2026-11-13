// Validation of an upgraded shadow: schema version, integrity, foreign keys and
// per-table row conservation against the untouched source files.
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { readSqliteRows, withRecoveredSource } from "./state-upgrade-tree.js";

export type ShadowTarget = { kind: "state" | "agent"; path: string };

export class ChainStepError extends Error {
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(message);
  }
}

function openReadOnly(pathname: string): DatabaseSync {
  return openNodeSqliteDatabase(pathname, { readOnly: true });
}

// Tables the shipped chain retires or merges into other tables or files. Any
// other table that loses rows is a conservation mismatch: logged and pinned.
const CHAIN_TRANSFORMED_TABLES = new Set([
  // State (v7-v13, v20, v29, v36, cron run log import).
  "agent_model_catalogs",
  "android_notification_recent_packages",
  "auth_profile_state",
  "auth_profile_stores",
  "clawhub_promotions_feed_state",
  "command_log_entries",
  "commitments",
  "cron_run_logs",
  "cron_store_epochs",
  "device_auth_tokens",
  "device_identities",
  "diagnostic_stability_bundles",
  "installed_plugin_index",
  "media_blobs",
  "model_capability_cache",
  "model_catalog_remote",
  "node_host_config",
  "node_pairing_paired",
  "node_pairing_pending",
  "onboarding_recommendations",
  "sidebar_sections",
  "skill_curator_state",
  "skill_lifecycle",
  "skill_workshop_collection_reviews",
  "skill_workshop_proposal_events",
  "skill_workshop_proposal_rollbacks",
  "skill_workshop_proposals",
  "state_leases",
  "tui_last_sessions",
  "update_check_state",
  "voicewake_routing_config",
  "voicewake_routing_routes",
  "voicewake_triggers",
  "web_push_vapid_keys",
  // Agent (v8-v27): session tables merge into session_nodes/session_windows; a
  // per-agent auth store that duplicates the shared one folds into shared state.
  "auth_profile_store",
  "cache_entries",
  "session_entries",
  "session_routes",
  "session_transcript_active_events",
  "session_transcript_generations",
  "sessions",
]);

function countRows(db: DatabaseSync): Map<string, number> {
  const counts = new Map<string, number>();
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'",
    )
    // SAFETY: the statement fixes the column names and types of each row.
    .all() as Array<{ name: string }>;
  for (const { name } of tables) {
    if (/_fts(_|$)|_vec(_|$)/u.test(name)) {
      continue;
    }
    counts.set(
      name,
      Number(
        readSqliteRows<{ n: number }>(
          db,
          `SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`,
        )[0]?.n ?? 0,
      ),
    );
  }
  return counts;
}

/** Integrity, foreign keys and version of every upgraded database in the shadow. */
export function validateShadow(
  targets: readonly ShadowTarget[],
  toShadow: (p: string) => string,
  readVersion: (db: DatabaseSync, kind: ShadowTarget["kind"]) => number,
  expectedVersion: (target: ShadowTarget) => number,
) {
  for (const target of targets) {
    const shadowPath = toShadow(target.path);
    const db = openReadOnly(shadowPath);
    try {
      const version = readVersion(db, target.kind);
      if (version !== expectedVersion(target)) {
        throw new ChainStepError(
          `${target.kind}-schema`,
          `${shadowPath} is at schema ${version} after the chain, expected ${expectedVersion(target)}`,
        );
      }
      // SAFETY: the statement fixes the column names and types of each row.
      const integrity = db.prepare("PRAGMA integrity_check").all() as Array<{
        integrity_check: string;
      }>;
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
        throw new ChainStepError("integrity_check", `${shadowPath} failed integrity_check`);
      }
      if (db.prepare("PRAGMA foreign_key_check").all().length > 0) {
        throw new ChainStepError("foreign_key_check", `${shadowPath} failed foreign_key_check`);
      }
    } finally {
      db.close();
    }
  }
}

export function conservationMismatches(
  targets: readonly ShadowTarget[],
  toShadow: (p: string) => string,
): string[] {
  const mismatches: string[] = [];
  for (const target of targets) {
    const sourceCounts = withRecoveredSource(target.path, (readable) => {
      const before = openReadOnly(readable);
      try {
        return countRows(before);
      } finally {
        before.close();
      }
    });
    const after = openReadOnly(toShadow(target.path));
    try {
      const resultCounts = countRows(after);
      for (const [table, rows] of sourceCounts) {
        // schema_meta is version metadata the stamp rewrites, not user data.
        if (rows === 0 || table === "schema_meta" || CHAIN_TRANSFORMED_TABLES.has(table)) {
          continue;
        }
        const kept = resultCounts.get(table) ?? 0;
        // Renamed claw_* tables keep their rows under template_*.
        const renamed = table.startsWith("claw_")
          ? (resultCounts.get(`template_${table.slice(5)}`) ?? 0)
          : 0;
        if (kept + renamed < rows) {
          mismatches.push(`${path.basename(target.path)}:${table} ${rows} -> ${kept + renamed}`);
        }
      }
    } finally {
      after.close();
    }
  }
  return mismatches;
}
