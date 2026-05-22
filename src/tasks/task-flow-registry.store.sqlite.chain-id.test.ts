import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  resolveTaskFlowRegistryDir,
  resolveTaskFlowRegistrySqlitePath,
} from "./task-flow-registry.paths.js";
import {
  closeTaskFlowRegistrySqliteStore,
  loadTaskFlowRegistryStateFromSqlite,
  upsertTaskFlowRegistryRecordToSqlite,
} from "./task-flow-registry.store.sqlite.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";

/**
 * Design invariants under test:
 *   (a) Idempotent-by-PRAGMA-guard schema migration (mirroring state_json).
 *   (b) Set-once-at-create, originating-chain semantic; UPDATE-on-hop deferred.
 *   (c) idx_flow_runs_chain_id supports SELECT-by-chain_id ORDER BY created_at.
 */

function makeFlow(overrides: Partial<TaskFlowRecord> = {}): TaskFlowRecord {
  const now = overrides.createdAt ?? 1_000;
  return {
    flowId: overrides.flowId ?? "flow-test-1",
    syncMode: "managed",
    ownerKey: "agent:main:main",
    controllerId: "tests/chain-id-controller",
    revision: 0,
    status: "queued",
    notifyPolicy: "done_only",
    goal: "chain-id round-trip pin",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function withSqliteFlowRegistry<T>(run: (path: string) => Promise<T> | T): Promise<T> {
  return await withTempDir({ prefix: "openclaw-flow-chain-id-" }, async (root) => {
    const prevState = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = root;
    try {
      const dbPath = resolveTaskFlowRegistrySqlitePath(process.env);
      return await run(dbPath);
    } finally {
      closeTaskFlowRegistrySqliteStore();
      if (prevState === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = prevState;
      }
    }
  });
}

describe("task-flow-registry sqlite store: chain_id", () => {
  beforeEach(() => {
    closeTaskFlowRegistrySqliteStore();
  });
  afterEach(() => {
    closeTaskFlowRegistrySqliteStore();
  });

  it("round-trips chain_id through upsert + load", async () => {
    await withSqliteFlowRegistry(() => {
      const flow = makeFlow({ flowId: "flow-rt-1", chainId: "chain-abc-123" });
      upsertTaskFlowRegistryRecordToSqlite(flow);
      const snap = loadTaskFlowRegistryStateFromSqlite();
      const restored = snap.flows.get("flow-rt-1");
      expect(restored).toBeDefined();
      expect(restored!.chainId).toBe("chain-abc-123");
    });
  });

  it("defaults chain_id to undefined (NULL in DB) when not provided", async () => {
    await withSqliteFlowRegistry(() => {
      const flow = makeFlow({ flowId: "flow-null-1" });
      upsertTaskFlowRegistryRecordToSqlite(flow);
      const snap = loadTaskFlowRegistryStateFromSqlite();
      const restored = snap.flows.get("flow-null-1");
      expect(restored).toBeDefined();
      expect(restored!.chainId).toBeUndefined();
    });
  });

  it("ensureSchema is idempotent (second invocation is no-op via PRAGMA guard)", async () => {
    await withSqliteFlowRegistry(() => {
      // First open creates the schema.
      upsertTaskFlowRegistryRecordToSqlite(makeFlow({ flowId: "flow-idem-1" }));
      // Close + reopen exercises ensureSchema again on existing DB.
      closeTaskFlowRegistrySqliteStore();
      upsertTaskFlowRegistryRecordToSqlite(makeFlow({ flowId: "flow-idem-2" }));
      const snap = loadTaskFlowRegistryStateFromSqlite();
      expect(snap.flows.has("flow-idem-1")).toBe(true);
      expect(snap.flows.has("flow-idem-2")).toBe(true);
    });
  });

  it("migrates from a pre-chain_id schema by adding the column once", async () => {
    await withSqliteFlowRegistry((dbPath) => {
      // Build a pre-chain_id schema by hand: omit chain_id entirely.
      mkdirSync(resolveTaskFlowRegistryDir(process.env), { recursive: true, mode: 0o700 });
      const { DatabaseSync } = requireNodeSqlite();
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE flow_runs (
          flow_id TEXT PRIMARY KEY,
          shape TEXT,
          sync_mode TEXT NOT NULL DEFAULT 'managed',
          owner_key TEXT NOT NULL,
          requester_origin_json TEXT,
          controller_id TEXT,
          revision INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          notify_policy TEXT NOT NULL,
          goal TEXT NOT NULL,
          current_step TEXT,
          blocked_task_id TEXT,
          blocked_summary TEXT,
          state_json TEXT,
          wait_json TEXT,
          cancel_requested_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          ended_at INTEGER
        );
      `);
      db.prepare(
        `INSERT INTO flow_runs (flow_id, sync_mode, owner_key, controller_id, revision, status, notify_policy, goal, created_at, updated_at)
         VALUES ('flow-legacy-1','managed','agent:main:main','tests/legacy',0,'queued','done_only','legacy',10,10)`,
      ).run();
      db.close();

      // First real open triggers ensureSchema -> ALTER TABLE ADD COLUMN chain_id.
      const snap1 = loadTaskFlowRegistryStateFromSqlite();
      expect(snap1.flows.has("flow-legacy-1")).toBe(true);
      expect(snap1.flows.get("flow-legacy-1")!.chainId).toBeUndefined();

      // Confirm column now present.
      const db2 = new DatabaseSync(dbPath);
      const cols = (
        db2.prepare(`PRAGMA table_info(flow_runs)`).all() as Array<{
          name?: string;
        }>
      ).map((r) => r.name);
      expect(cols).toContain("chain_id");
      // Index should exist as well.
      const indexRows = db2.prepare(`PRAGMA index_list(flow_runs)`).all() as Array<{
        name?: string;
      }>;
      const indexNames = indexRows.map((r) => r.name);
      expect(indexNames).toContain("idx_flow_runs_chain_id");
      db2.close();

      // Second open is a no-op for the migration (ensureSchema must be idempotent).
      closeTaskFlowRegistrySqliteStore();
      const snap2 = loadTaskFlowRegistryStateFromSqlite();
      expect(snap2.flows.has("flow-legacy-1")).toBe(true);
    });
  });

  it("supports chain-walk: SELECT by chain_id ORDER BY created_at preserves insertion order", async () => {
    await withSqliteFlowRegistry((dbPath) => {
      const chainId = "chain-walk-xyz";
      const a = makeFlow({ flowId: "flow-walk-a", chainId, createdAt: 100, updatedAt: 100 });
      const b = makeFlow({ flowId: "flow-walk-b", chainId, createdAt: 200, updatedAt: 200 });
      const c = makeFlow({ flowId: "flow-walk-c", chainId, createdAt: 300, updatedAt: 300 });
      const other = makeFlow({
        flowId: "flow-walk-other",
        chainId: "chain-other",
        createdAt: 150,
        updatedAt: 150,
      });
      // Insert out of order to confirm ORDER BY is doing the work.
      upsertTaskFlowRegistryRecordToSqlite(b);
      upsertTaskFlowRegistryRecordToSqlite(other);
      upsertTaskFlowRegistryRecordToSqlite(c);
      upsertTaskFlowRegistryRecordToSqlite(a);

      const { DatabaseSync } = requireNodeSqlite();
      const db = new DatabaseSync(dbPath);
      const rows = db
        .prepare(`SELECT flow_id FROM flow_runs WHERE chain_id = ? ORDER BY created_at ASC`)
        .all(chainId) as Array<{ flow_id: string }>;
      db.close();
      expect(rows.map((r) => r.flow_id)).toEqual(["flow-walk-a", "flow-walk-b", "flow-walk-c"]);
    });
  });

  it("does NOT update chain_id on conflict (set-once invariant (b))", async () => {
    await withSqliteFlowRegistry(() => {
      const initial = makeFlow({ flowId: "flow-soc-1", chainId: "chain-origin-A" });
      upsertTaskFlowRegistryRecordToSqlite(initial);

      // Simulate a hop that *attempts* to overwrite chain_id via upsert.
      // The ON CONFLICT clause intentionally omits chain_id, so the original
      // value must be preserved.
      const hop: TaskFlowRecord = {
        ...initial,
        chainId: "chain-different-B",
        revision: initial.revision + 1,
        updatedAt: initial.updatedAt + 10,
      };
      upsertTaskFlowRegistryRecordToSqlite(hop);

      const snap = loadTaskFlowRegistryStateFromSqlite();
      const restored = snap.flows.get("flow-soc-1");
      expect(restored).toBeDefined();
      expect(restored!.chainId).toBe("chain-origin-A");
      // Other fields *should* update on conflict — sanity check.
      expect(restored!.revision).toBe(1);
    });
  });
});
