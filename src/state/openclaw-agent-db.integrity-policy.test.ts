import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import type { SqliteIntegrityDiagnostics } from "../infra/sqlite-integrity.js";
import {
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "./openclaw-agent-db-lease.js";
import * as schema from "./openclaw-agent-db-schema.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import * as verifier from "./openclaw-database-verify.js";
import {
  clearOpenClawAgentIntegrityVerification,
  readOpenClawAgentIntegrityVerification,
  resolveQuarantineStorePath,
} from "./openclaw-quarantine-store.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

it.each(
  (["clean", "missing", "unclean", "version", "replacement"] as const).flatMap((mode) =>
    (mode === "unclean" ? ["reset", "retained"] : ["reset", "retained", "shared"]).map(
      (runtimeProof) => ({ mode, runtimeProof }),
    ),
  ),
)(
  "uses durable $mode state for the next open ($runtimeProof runtime proof)",
  ({ mode, runtimeProof }) => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("agent-integrity-policy-") };
    const options = { agentId: "policy", env };
    const original = openOpenClawAgentDatabase(options);
    original.db.exec("INSERT INTO auth_profile_state VALUES ('preserved', '{\"ok\":true}', 1)");
    if (runtimeProof !== "reset") {
      closeOpenClawAgentDatabaseByPath(original.path);
    } else {
      closeOpenClawAgentDatabasesForTest();
    }
    const before = readOpenClawAgentIntegrityVerification(original.path, env);
    expect(before?.clean_close).toBe(1);
    const lease =
      runtimeProof === "shared"
        ? claimOpenClawAgentDatabaseLease({ ...options, path: original.path })
        : undefined;
    try {
      if (mode === "missing") {
        clearOpenClawAgentIntegrityVerification(original.path, env);
      } else if (mode === "unclean") {
        readOpenClawAgentIntegrityVerification(original.path, env, true);
      } else if (mode === "version") {
        const store = openNodeSqliteDatabase(
          path.join(env.OPENCLAW_STATE_DIR, "state/openclaw-quarantine.sqlite"),
        );
        try {
          store.exec("UPDATE agent_integrity_verifications SET app_version='previous-release'");
        } finally {
          store.close();
        }
      } else if (mode === "replacement") {
        fs.copyFileSync(original.path, `${original.path}.replacement`);
        fs.renameSync(`${original.path}.replacement`, original.path);
      }
      const gate = schema.agentDatabaseIntegrityBeforeMutationSteps;
      let diagnostics: SqliteIntegrityDiagnostics | undefined;
      vi.spyOn(schema, "agentDatabaseIntegrityBeforeMutationSteps").mockImplementation(function* (
        ...args
      ) {
        const result = yield* gate(...args);
        diagnostics = args[3];
        return result;
      });
      const queued = vi
        .spyOn(verifier, "requestOpenClawAgentDatabaseQuickCheck")
        .mockImplementation(() => {});
      const reopened = openOpenClawAgentDatabase(options);
      expect(
        reopened.db
          .prepare("SELECT state_json FROM auth_profile_state WHERE state_key='preserved'")
          .get(),
      ).toEqual({ state_json: '{"ok":true}' });
      expect(diagnostics?.integrityGateOutcome).toBe(mode === "clean" ? "cached" : "healthy");
      expect(queued).toHaveBeenCalledTimes(mode === "clean" ? 1 : 0);
      expect(readOpenClawAgentIntegrityVerification(original.path, env)?.clean_close).toBe(
        runtimeProof === "shared" && mode === "missing" ? undefined : 0,
      );
    } finally {
      if (lease) {
        releaseOpenClawAgentDatabaseLease(lease, { env }, "read-only");
      }
    }
  },
);

it("adopts the released quarantine schema without changing its rows or version", () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("agent-integrity-upgrade-") };
  const storePath = resolveQuarantineStorePath(env);
  const quarantinedPath = path.join(env.OPENCLAW_STATE_DIR, "retained.sqlite");
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const previous = openNodeSqliteDatabase(storePath);
  try {
    // The quarantine schema shipped in v2026.9.5 has no integrity-receipt table.
    previous.exec(`
      CREATE TABLE quarantined_databases (
        path TEXT NOT NULL PRIMARY KEY,
        kind TEXT NOT NULL,
        reason TEXT NOT NULL,
        quarantined_at INTEGER NOT NULL,
        writer_app_version TEXT,
        verified_generation TEXT
      ) STRICT;
      PRAGMA user_version = 2;
    `);
    previous
      .prepare("INSERT INTO quarantined_databases VALUES (?, ?, ?, ?, ?, ?)")
      .run(quarantinedPath, "agent", "retained quarantine", 1, "2026.9.5", null);
  } finally {
    previous.close();
  }

  const database = openOpenClawAgentDatabase({ agentId: "upgraded", env });
  expect(readOpenClawAgentIntegrityVerification(database.path, env)?.clean_close).toBe(0);
  const upgraded = openNodeSqliteDatabase(storePath, { readOnly: true });
  try {
    expect(upgraded.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    expect(upgraded.prepare("SELECT * FROM quarantined_databases").all()).toEqual([
      {
        path: quarantinedPath,
        kind: "agent",
        reason: "retained quarantine",
        quarantined_at: 1,
        writer_app_version: "2026.9.5",
        verified_generation: null,
      },
    ]);
  } finally {
    upgraded.close();
  }
});

it("refuses admission when the durable dirty-marker write fails", () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("agent-integrity-dirty-failure-") };
  const options = { agentId: "policy", env };
  const agent = openOpenClawAgentDatabase(options);
  closeOpenClawAgentDatabasesForTest();
  const store = openNodeSqliteDatabase(
    path.join(env.OPENCLAW_STATE_DIR, "state/openclaw-quarantine.sqlite"),
  );
  try {
    store.exec(
      "CREATE TRIGGER reject_dirty BEFORE UPDATE OF clean_close ON agent_integrity_verifications BEGIN SELECT RAISE(ABORT, 'synthetic dirty write failed'); END;",
    );
    expect(() => openOpenClawAgentDatabase(options)).toThrow(/synthetic dirty write failed/);
    expect(readOpenClawAgentIntegrityVerification(agent.path, env)?.clean_close).toBe(1);
    store.exec("DROP TRIGGER reject_dirty;");
    expect(openOpenClawAgentDatabase(options).agentId).toBe("policy");
    expect(readOpenClawAgentIntegrityVerification(agent.path, env)?.clean_close).toBe(0);
  } finally {
    store.close();
  }
});
