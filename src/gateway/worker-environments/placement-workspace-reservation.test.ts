import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { ensureLocal } from "./placement-row-codec.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";

const IDENTITY = {
  sessionId: "workspace-publication",
  agentId: "main",
  sessionKey: "agent:main:workspace-publication",
};
const NOW_MS = 1_756_000_000_000;
const businessSql =
  /\bworker_(?:session_placements|workspace_pending_results|workspace_reconciliations)\b/i;

describe("workspace publication reservation authority", () => {
  const roots = useStateDatabaseTempDirs();
  let database: OpenClawStateDatabase;
  let placements: WorkerSessionPlacementStore;

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", roots.make("workspace-publication-authority-"));
    database = openOpenClawStateDatabase();
    placements = createWorkerSessionPlacementStore({ database });
  });
  afterEach(() => vi.unstubAllEnvs());

  function seedLocal() {
    runOpenClawStateWriteTransaction(({ db }) => ensureLocal(db, IDENTITY, NOW_MS), { database });
  }

  function foreignWrite(write: (db: DatabaseSync) => void) {
    // Keep the admitted host open: this connection deliberately bypasses owner publications.
    const foreign = new DatabaseSync(database.path);
    try {
      write(foreign);
    } finally {
      foreign.close();
    }
  }

  function insertRecovery(db: DatabaseSync, kind: "pending" | "reconciling") {
    const query = getNodeSqliteKysely<DB>(db);
    const authority = {
      session_id: IDENTITY.sessionId,
      environment_id: "environment-1",
      owner_epoch: 7,
      placement_generation: 0,
      created_at_ms: NOW_MS,
    };
    if (kind === "pending") {
      executeSqliteQuerySync(
        db,
        query.insertInto("worker_workspace_pending_results").values({
          ...authority,
          claim_id: "claim-1",
          run_id: "run-1",
          gateway_instance_id: "gateway-1",
        }),
      );
    } else {
      executeSqliteQuerySync(
        db,
        query.insertInto("worker_workspace_reconciliations").values({
          ...authority,
          base_manifest_ref: "base-1",
          current_manifest_ref: "current-1",
          plan_json: "{}",
          base_pack: Buffer.alloc(0),
        }),
      );
    }
  }

  it.each([
    { reserve: "withLocalWorkspaceReservation", hasPlacement: false },
    { reserve: "withLocalWorkspaceReservation", hasPlacement: true },
    { reserve: "withRepositoryWorkspaceReservation", hasPlacement: true },
  ] as const)(
    "$reserve reads one current snapshot per authority check (placement=$hasPlacement)",
    async ({ reserve, hasPlacement }) => {
      if (hasPlacement) {
        seedLocal();
      }
      const reads = observeSqliteReadSql(StatementSync.prototype);
      const effect = vi.fn();
      try {
        await placements[reserve](IDENTITY, async (assertCurrent) => {
          expect(reads.queries.filter((sql) => businessSql.test(sql))).toHaveLength(1);
          assertCurrent();
          effect();
          expect(reads.queries.filter((sql) => businessSql.test(sql))).toHaveLength(2);
        });
        expect(effect).toHaveBeenCalledOnce();
      } finally {
        reads.restore();
      }
    },
  );

  it.each(["generation", "owner", "pending", "reconciling", "unsafe-integer"] as const)(
    "rejects a foreign %s change after preparation without performing the effect",
    async (change) => {
      seedLocal();
      if (change === "owner") {
        executeSqliteQuerySync(
          database.db,
          getNodeSqliteKysely<DB>(database.db)
            .updateTable("worker_session_placements")
            .set({
              state: "active",
              execution_mode: "remote-exec",
              environment_id: "environment-1",
              active_owner_epoch: 7,
              workspace_base_manifest_ref: "base-1",
              remote_workspace_dir: "/worker/workspace",
              worker_bundle_hash: "bundle-1",
            })
            .where("session_id", "=", IDENTITY.sessionId),
        );
      }
      const reserve =
        change === "owner"
          ? placements.withRepositoryWorkspaceReservation
          : placements.withLocalWorkspaceReservation;
      const effect = vi.fn();
      await expect(
        reserve(IDENTITY, async (assertCurrent) => {
          assertCurrent();
          foreignWrite((db) => {
            if (change === "pending" || change === "reconciling") {
              insertRecovery(db, change);
            } else if (change === "unsafe-integer") {
              db.prepare(
                "UPDATE worker_session_placements SET created_at_ms = ? WHERE session_id = ?",
              ).run(9_007_199_254_740_993n, IDENTITY.sessionId);
            } else {
              executeSqliteQuerySync(
                db,
                getNodeSqliteKysely<DB>(db)
                  .updateTable("worker_session_placements")
                  .set(
                    change === "owner" ? { active_owner_epoch: 8 } : { transition_generation: 1 },
                  )
                  .where("session_id", "=", IDENTITY.sessionId),
              );
            }
          });
          assertCurrent();
          effect();
        }),
      ).rejects.toThrow(
        change === "pending" || change === "reconciling"
          ? "still reconciling"
          : change === "unsafe-integer"
            ? "safe integer range"
            : "placement changed during publication",
      );
      expect(effect).not.toHaveBeenCalled();
    },
  );

  it.each(["pending", "reconciling"] as const)(
    "refuses an orphaned %s row even without a placement",
    async (kind) => {
      const effect = vi.fn();
      await expect(
        placements.withLocalWorkspaceReservation(IDENTITY, async (assertCurrent) => {
          // Introduce the orphan after admission so the final guard, not startup integrity, observes it.
          foreignWrite((db) => {
            db.exec("PRAGMA foreign_keys = OFF");
            insertRecovery(db, kind);
          });
          assertCurrent();
          effect();
        }),
      ).rejects.toThrow("still reconciling");
      expect(effect).not.toHaveBeenCalled();
    },
  );
});
