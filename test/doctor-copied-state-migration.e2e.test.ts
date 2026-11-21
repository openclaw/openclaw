// Regression for the copied shared-state upgrade reported from 2026.6.1-beta.1.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../src/state/openclaw-state-schema.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

const historicalColumns = (names: string, type = "TEXT") =>
  `${names.replaceAll(" ", ` ${type},\n  `)} ${type}`;
const historicalIndex = (
  table: string,
  name: string,
  columns: string,
  suffix = "",
  unique = false,
) =>
  `CREATE ${unique ? "UNIQUE " : ""}INDEX idx_${table}_${name} ON ${table}(${columns})${suffix};`;

const HISTORICAL_DEVICE_BOOTSTRAP_TOKENS_SQL = `
CREATE TABLE device_bootstrap_tokens (
  token_key TEXT NOT NULL PRIMARY KEY,
  token TEXT NOT NULL,
  ts INTEGER NOT NULL,
  ${historicalColumns("device_id public_key profile_json redeemed_profile_json pending_profile_json")},
  issued_at_ms INTEGER NOT NULL,
  last_used_at_ms INTEGER
);

${historicalIndex("device_bootstrap_tokens", "ts", "ts")}
`;

// Emit the original predicate order: Doctor accepts only the exact legacy DDL.
const resolvedApproval = "resolved_at_ms IS NOT NULL AND resolver_kind IS NOT NULL";
const unconsumedApproval = "consumed_at_ms IS NULL AND consumed_by IS NULL";
const nullFields = (columns: string) => `${columns.replaceAll(" ", " IS NULL AND ")} IS NULL`;
const rejectedApproval = (status: string, reason: string) =>
  `( status = '${status}' AND decision = 'deny' AND terminal_reason ${reason} AND ${resolvedApproval} AND ${unconsumedApproval} )`;
const historicalApprovalStates = [
  `( status = 'pending' AND ${nullFields("decision terminal_reason resolved_at_ms resolver_kind resolver_id consumed_at_ms consumed_by")} )`,
  `( status = 'allowed' AND decision IN ('allow-once', 'allow-always') AND terminal_reason = 'user' AND ${resolvedApproval} )`,
  rejectedApproval("denied", "IN ('user', 'malformed-verdict', 'no-route', 'storage-corrupt')"),
  rejectedApproval("expired", "= 'timeout'"),
  rejectedApproval("cancelled", "IN ('run-aborted', 'gateway-restart')"),
].join(" OR ");

const HISTORICAL_OPERATOR_APPROVALS_SQL = `
CREATE TABLE operator_approvals (
  approval_id TEXT NOT NULL PRIMARY KEY CHECK (
    length(approval_id) > 0 AND approval_id NOT IN ('.', '..')
  ),
  resolution_ref TEXT NOT NULL CHECK (
    length(resolution_ref) = 43 AND resolution_ref NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  kind TEXT NOT NULL CHECK (kind IN ('exec', 'plugin')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'allowed', 'denied', 'expired', 'cancelled')),
  presentation_json TEXT NOT NULL,
  ${historicalColumns("requested_by_device_id requested_by_client_id")},
  requested_by_device_token_auth INTEGER NOT NULL DEFAULT 0,
  reviewer_device_ids_json TEXT NOT NULL,
  ${historicalColumns("source_agent_id source_session_key source_session_id source_run_id source_tool_call_id source_tool_name")},
  audience_session_keys_json TEXT NOT NULL,
  runtime_epoch TEXT NOT NULL,
  ${historicalColumns("created_at_ms expires_at_ms updated_at_ms", "INTEGER NOT NULL")},
  decision TEXT CHECK (decision IN ('allow-once', 'allow-always', 'deny')),
  terminal_reason TEXT CHECK (
    terminal_reason IN (
      'user',
      'timeout',
      'malformed-verdict',
      'no-route',
      'run-aborted',
      'gateway-restart',
      'storage-corrupt'
    )
  ),
  resolved_at_ms INTEGER,
  resolver_kind TEXT CHECK (resolver_kind IN ('device', 'channel', 'runtime', 'system')),
  resolver_id TEXT,
  consumed_at_ms INTEGER,
  consumed_by TEXT,
  CHECK (expires_at_ms >= created_at_ms),
  CHECK (updated_at_ms >= created_at_ms),
  CHECK (resolved_at_ms IS NULL OR resolved_at_ms >= created_at_ms),
  CHECK (resolved_at_ms IS NULL OR resolved_at_ms <= updated_at_ms),
  CHECK (consumed_at_ms IS NULL OR consumed_at_ms >= resolved_at_ms),
  CHECK (consumed_at_ms IS NULL OR consumed_at_ms <= updated_at_ms),
  CHECK (requested_by_device_token_auth IN (0, 1)),
  CHECK ( ${historicalApprovalStates} ),
  CHECK (
    (consumed_at_ms IS NULL AND consumed_by IS NULL)
    OR (
      status = 'allowed'
      AND decision = 'allow-once'
      AND consumed_at_ms IS NOT NULL
      AND consumed_by IS NOT NULL
    )
  )
);

${historicalIndex("operator_approvals", "status_expiry", "status, expires_at_ms, approval_id")}
${historicalIndex("operator_approvals", "resolution_ref", "resolution_ref", "", true)}
${historicalIndex("operator_approvals", "source_session_created", "source_session_key, created_at_ms DESC, approval_id")}
${historicalIndex("operator_approvals", "resolved", "resolved_at_ms, approval_id", " WHERE resolved_at_ms IS NOT NULL")}
${historicalIndex("operator_approvals", "runtime_pending", "runtime_epoch, approval_id", " WHERE status = 'pending'")}
`;

function writeHistoricalCopiedStateFixture(stateDir: string): void {
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  using database = new DatabaseSync(databasePath);
  database.exec(OPENCLAW_STATE_SCHEMA_SQL);
  database.exec(`
      DROP TABLE device_bootstrap_tokens;
      ${HISTORICAL_DEVICE_BOOTSTRAP_TOKENS_SQL}
      DROP TABLE operator_approvals;
      ${HISTORICAL_OPERATOR_APPROVALS_SQL}
      DROP INDEX idx_worker_session_placements_environment;
      PRAGMA user_version = 2;
      INSERT INTO schema_meta (
        meta_key, role, schema_version, agent_id, app_version, created_at, updated_at
      ) VALUES ('primary', 'global', 2, NULL, NULL, 0, 0);
      INSERT INTO device_bootstrap_tokens (token_key, token, ts, issued_at_ms)
      VALUES ('fixture-bootstrap', 'fixture-token', 1000, 1000);
    `);
}

it(
  "repairs the retained 2026.6.1-beta.1 shared state before gateway readiness",
  { timeout: 180_000 },
  async () => {
    const instance = await createOpenClawTestInstance({ name: "doctor-copied-state" });
    try {
      writeHistoricalCopiedStateFixture(instance.stateDir);

      const doctor = await instance.cli(
        ["doctor", "--fix", "--non-interactive", "--yes", "--no-workspace-suggestions"],
        { timeoutMs: 120_000 },
      );

      expect(doctor.code, `${doctor.stdout}\n${doctor.stderr}`).toBe(0);
      expect(`${doctor.stdout}\n${doctor.stderr}`).not.toContain(
        "Failed migrating shared state database schema",
      );
      await instance.startGateway();
    } finally {
      await instance.cleanup();
    }
  },
);
