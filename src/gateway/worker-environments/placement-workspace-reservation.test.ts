import { StatementSync } from "node:sqlite";
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

  it.each([
    { reserve: "withLocalWorkspaceReservation", hasPlacement: false },
    { reserve: "withLocalWorkspaceReservation", hasPlacement: true },
    { reserve: "withRepositoryWorkspaceReservation", hasPlacement: true },
  ] as const)(
    "$reserve prepares in a worker and validates effects without main-thread SQL (placement=$hasPlacement)",
    async ({ reserve, hasPlacement }) => {
      if (hasPlacement) {
        seedLocal();
      }
      const reads = observeSqliteReadSql(StatementSync.prototype);
      const effect = vi.fn();
      try {
        await placements[reserve](IDENTITY, async (assertCurrent) => {
          assertCurrent();
          effect();
          assertCurrent();
        });
        expect(effect).toHaveBeenCalledOnce();
        expect(reads.queries.filter((sql) => businessSql.test(sql))).toEqual([]);
      } finally {
        reads.restore();
      }
    },
  );

  it("rejects an in-process retirement before the publication effect", async () => {
    seedLocal();
    const effect = vi.fn();
    await expect(
      placements.withLocalWorkspaceReservation(IDENTITY, async (assertCurrent) => {
        await placements.retireSessionPlacementAsync({
          sessionId: IDENTITY.sessionId,
          expectedState: "local",
          expectedGeneration: 0,
        });
        assertCurrent();
        effect();
      }),
    ).rejects.toThrow("placement authority changed");
    expect(effect).not.toHaveBeenCalled();
  });

  it.each(["pending", "reconciling"] as const)(
    "refuses an orphaned %s row before publication",
    async (kind) => {
      const query = getNodeSqliteKysely<DB>(database.db);
      const authority = {
        session_id: IDENTITY.sessionId,
        environment_id: "environment-1",
        owner_epoch: 7,
        placement_generation: 0,
        created_at_ms: NOW_MS,
      };
      database.db.exec("PRAGMA foreign_keys = OFF");
      try {
        if (kind === "pending") {
          executeSqliteQuerySync(
            database.db,
            query.insertInto("worker_workspace_pending_results").values({
              ...authority,
              claim_id: "claim-1",
              run_id: "run-1",
              gateway_instance_id: "gateway-1",
            }),
          );
        } else {
          executeSqliteQuerySync(
            database.db,
            query.insertInto("worker_workspace_reconciliations").values({
              ...authority,
              base_manifest_ref: "base-1",
              current_manifest_ref: "current-1",
              plan_json: "{}",
              base_pack: Buffer.alloc(0),
            }),
          );
        }
      } finally {
        database.db.exec("PRAGMA foreign_keys = ON");
      }
      const effect = vi.fn();
      await expect(
        placements.withLocalWorkspaceReservation(IDENTITY, async (assertCurrent) => {
          assertCurrent();
          effect();
        }),
      ).rejects.toThrow("still reconciling");
      expect(effect).not.toHaveBeenCalled();
    },
  );
});
