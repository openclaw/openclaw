// Octopus Orchestrator — registry SQLite migration tests (M1-01)
//
// Covers:
//   - schema application creates every expected table on a fresh DB
//   - every mutable table has a `version INTEGER NOT NULL DEFAULT 0` column
//   - `artifacts` intentionally has no `version` column (immutable)
//   - round-trip insert/select for missions, arms, grips (the three
//     registry rows the scheduler touches most)
//   - schema application is idempotent (re-running is a no-op)
//   - `resolveOctoRegistryPath` honours OPENCLAW_STATE_DIR override
//   - `resolveOctoRegistryPath` falls back to `<home>/.openclaw` when unset
//   - `openOctoRegistry` creates a missing parent directory
//   - `openOctoRegistry` chmods the DB file to 0600 on first creation
//     (POSIX only — Windows is skipped for the mode check)
//   - `closeOctoRegistry` runs without error

import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  applySchema,
  closeOctoRegistry,
  openOctoRegistry,
  resolveOctoRegistryPath,
} from "./migrate.js";

type TableInfoRow = {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

type SqliteMasterRow = { name: string };

type CountRow = { n: number };

const EXPECTED_TABLES = ["missions", "arms", "grips", "claims", "leases", "artifacts"] as const;
const MUTABLE_TABLES = ["missions", "arms", "grips", "claims", "leases"] as const;

const openHandles: DatabaseSync[] = [];
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function openTestDb(dbPath: string): DatabaseSync {
  const db = openOctoRegistry({ path: dbPath });
  openHandles.push(db);
  return db;
}

function tableColumns(db: DatabaseSync, table: string): TableInfoRow[] {
  // PRAGMA table_info cannot be parameterized; table is an internal constant
  // from EXPECTED_TABLES, not user input.
  return db.prepare(`PRAGMA table_info(${table})`).all() as unknown as TableInfoRow[];
}

function listTables(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as unknown as SqliteMasterRow[];
  return rows.map((row) => row.name);
}

afterEach(() => {
  while (openHandles.length > 0) {
    const db = openHandles.pop();
    if (db) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
});

describe("openOctoRegistry — schema bootstrap", () => {
  it("creates every expected table on a fresh database", () => {
    const dir = makeTempDir("octo-migrate-tables-");
    const dbPath = path.join(dir, "octo", "registry.sqlite");
    const db = openTestDb(dbPath);
    const tables = new Set(listTables(db));
    for (const name of EXPECTED_TABLES) {
      expect(tables.has(name), `expected table ${name}`).toBe(true);
    }
  });

  it("gives every mutable table a NOT NULL version column defaulting to 0", () => {
    const dir = makeTempDir("octo-migrate-version-");
    const db = openTestDb(path.join(dir, "registry.sqlite"));
    for (const table of MUTABLE_TABLES) {
      const cols = tableColumns(db, table);
      const version = cols.find((c) => c.name === "version");
      expect(version, `${table}.version`).toBeDefined();
      if (!version) {
        continue;
      }
      expect(version.type.toUpperCase()).toBe("INTEGER");
      expect(version.notnull).toBe(1);
      expect(version.dflt_value).toBe("0");
    }
  });

  it("does NOT give the artifacts table a version column (immutable)", () => {
    const dir = makeTempDir("octo-migrate-artifacts-");
    const db = openTestDb(path.join(dir, "registry.sqlite"));
    const cols = tableColumns(db, "artifacts");
    const version = cols.find((c) => c.name === "version");
    expect(version).toBeUndefined();
  });

  it("is idempotent: re-applying the schema is a no-op", () => {
    const dir = makeTempDir("octo-migrate-idempotent-");
    const db = openTestDb(path.join(dir, "registry.sqlite"));
    expect(() => applySchema(db)).not.toThrow();
    expect(() => applySchema(db)).not.toThrow();
    // tables should still be the same set
    const tables = new Set(listTables(db));
    for (const name of EXPECTED_TABLES) {
      expect(tables.has(name)).toBe(true);
    }
  });

  it("creates the parent directory if missing", () => {
    const dir = makeTempDir("octo-migrate-parent-");
    const deep = path.join(dir, "a", "b", "c", "registry.sqlite");
    const db = openTestDb(deep);
    // If we got this far, parent was created.
    expect(listTables(db).length).toBeGreaterThan(0);
  });

  it("chmods the DB file to 0600 on first creation (POSIX only)", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir("octo-migrate-chmod-");
    const dbPath = path.join(dir, "registry.sqlite");
    openTestDb(dbPath);
    const mode = statSync(dbPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("closeOctoRegistry closes without error", () => {
    const dir = makeTempDir("octo-migrate-close-");
    const dbPath = path.join(dir, "registry.sqlite");
    const db = openOctoRegistry({ path: dbPath });
    expect(() => closeOctoRegistry(db)).not.toThrow();
  });
});

describe("openOctoRegistry — round-trip inserts", () => {
  it("round-trips a mission row", () => {
    const dir = makeTempDir("octo-migrate-mission-");
    const db = openTestDb(path.join(dir, "registry.sqlite"));
    const now = 1_700_000_000_000;
    db.prepare(
      `INSERT INTO missions (
         mission_id, title, owner, status, policy_profile_ref,
         spec_json, metadata_json, created_at, updated_at, version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "MIS01HZ",
      "Refactor the storage layer",
      "operator:alice",
      "active",
      null,
      JSON.stringify({ spec_version: 1, title: "Refactor" }),
      JSON.stringify({ source: "cli" }),
      now,
      now,
      0,
    );
    const row = db.prepare("SELECT * FROM missions WHERE mission_id = ?").get("MIS01HZ") as Record<
      string,
      unknown
    >;
    expect(row.title).toBe("Refactor the storage layer");
    expect(row.owner).toBe("operator:alice");
    expect(row.status).toBe("active");
    expect(row.version).toBe(0);
    expect(Number(row.created_at)).toBe(now);
  });

  it("round-trips an arm row", () => {
    const dir = makeTempDir("octo-migrate-arm-");
    const db = openTestDb(path.join(dir, "registry.sqlite"));
    const now = 1_700_000_000_000;
    db.prepare(
      `INSERT INTO arms (
         arm_id, mission_id, node_id, adapter_type, runtime_name, agent_id,
         task_ref, state, current_grip_id, lease_owner, lease_expiry_ts,
         session_ref_json, checkpoint_ref, health_status, restart_count,
         policy_profile, spec_json, created_at, updated_at, version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "ARM01HZ",
      "MIS01HZ",
      "node-local",
      "pty_tmux",
      "tmux:bash",
      "agent-default",
      null,
      "active",
      null,
      "head-1",
      now + 30_000,
      JSON.stringify({ tmux_session_name: "arm-ARM01HZ", cwd: "/tmp" }),
      null,
      "healthy",
      0,
      null,
      JSON.stringify({ spec_version: 1, adapter_type: "pty_tmux" }),
      now,
      now,
      0,
    );
    const row = db.prepare("SELECT * FROM arms WHERE arm_id = ?").get("ARM01HZ") as Record<
      string,
      unknown
    >;
    expect(row.mission_id).toBe("MIS01HZ");
    expect(row.adapter_type).toBe("pty_tmux");
    expect(row.state).toBe("active");
    expect(row.restart_count).toBe(0);
    expect(row.version).toBe(0);

    const count = db
      .prepare("SELECT COUNT(*) AS n FROM arms WHERE mission_id = ?")
      .get("MIS01HZ") as CountRow;
    expect(count.n).toBe(1);
  });

  it("round-trips a grip row", () => {
    const dir = makeTempDir("octo-migrate-grip-");
    const db = openTestDb(path.join(dir, "registry.sqlite"));
    const now = 1_700_000_000_000;
    db.prepare(
      `INSERT INTO grips (
         grip_id, mission_id, type, input_ref, priority, assigned_arm_id,
         status, timeout_s, side_effecting, idempotency_key, result_ref,
         spec_json, created_at, updated_at, version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "GRP01HZ",
      "MIS01HZ",
      "code-review",
      "artifact:input:GRP01HZ",
      5,
      null,
      "pending",
      600,
      0,
      null,
      null,
      JSON.stringify({ spec_version: 1, type: "code-review" }),
      now,
      now,
      0,
    );
    const row = db.prepare("SELECT * FROM grips WHERE grip_id = ?").get("GRP01HZ") as Record<
      string,
      unknown
    >;
    expect(row.type).toBe("code-review");
    expect(row.priority).toBe(5);
    expect(row.status).toBe("pending");
    expect(row.side_effecting).toBe(0);
    expect(row.version).toBe(0);
  });
});

describe("resolveOctoRegistryPath", () => {
  it("honours OPENCLAW_STATE_DIR when set", () => {
    const dir = makeTempDir("octo-migrate-envpath-");
    const resolved = resolveOctoRegistryPath({ OPENCLAW_STATE_DIR: dir } as NodeJS.ProcessEnv);
    expect(resolved).toBe(path.join(dir, "octo", "registry.sqlite"));
  });

  it("falls back to <homedir>/.openclaw when OPENCLAW_STATE_DIR is unset", () => {
    const resolved = resolveOctoRegistryPath({} as NodeJS.ProcessEnv);
    expect(resolved).toBe(path.join(os.homedir(), ".openclaw", "octo", "registry.sqlite"));
  });

  it("ignores empty-string OPENCLAW_STATE_DIR and falls back to home", () => {
    const resolved = resolveOctoRegistryPath({ OPENCLAW_STATE_DIR: "   " } as NodeJS.ProcessEnv);
    expect(resolved).toBe(path.join(os.homedir(), ".openclaw", "octo", "registry.sqlite"));
  });
});
