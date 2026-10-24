import { StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { REQUEST as IDENTITY } from "./placement-dispatch-test-fixtures.js";
import { ensureLocal } from "./placement-row-codec.js";
import { usePlacementStoreFixture } from "./placement-store-fixture.test-support.js";

const NOW_MS = 1_756_000_000_000;
const businessSql =
  /\bworker_(?:session_placements|workspace_pending_results|workspace_reconciliations)\b/i;

const fixture = usePlacementStoreFixture(undefined, undefined, Date.now);

function seedLocal() {
  const { database } = fixture;
  runOpenClawStateWriteTransaction(({ db }) => ensureLocal(db, IDENTITY, NOW_MS), { database });
}

it.each([
  { reserve: "withLocalWorkspaceReservation", hasPlacement: false },
  { reserve: "withLocalWorkspaceReservation", hasPlacement: true },
  { reserve: "withRepositoryWorkspaceReservation", hasPlacement: true },
] as const)(
  "$reserve prepares in a worker and validates effects without main-thread SQL (placement=$hasPlacement)",
  async ({ reserve, hasPlacement }) => {
    const { store: placements } = fixture;
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

it.each(["retirement", "pending", "reconciling"] as const)(
  "refuses publication after %s invalidates authority",
  async (kind) => {
    const { database, store: placements } = fixture;
    if (kind === "retirement") {
      seedLocal();
    } else {
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
        executeSqliteQuerySync(
          database.db,
          kind === "pending"
            ? query.insertInto("worker_workspace_pending_results").values({
                ...authority,
                claim_id: "claim-1",
                run_id: "run-1",
                gateway_instance_id: "gateway-1",
              })
            : query.insertInto("worker_workspace_reconciliations").values({
                ...authority,
                base_manifest_ref: "base-1",
                current_manifest_ref: "current-1",
                plan_json: "{}",
                base_pack: Buffer.alloc(0),
              }),
        );
      } finally {
        database.db.exec("PRAGMA foreign_keys = ON");
      }
    }
    const effect = vi.fn();
    await expect(
      placements.withLocalWorkspaceReservation(IDENTITY, async (assertCurrent) => {
        if (kind === "retirement") {
          await placements.retireSessionPlacementAsync({
            sessionId: IDENTITY.sessionId,
            expectedState: "local",
            expectedGeneration: 0,
          });
        }
        assertCurrent();
        effect();
      }),
    ).rejects.toThrow(kind === "retirement" ? "placement authority changed" : "still reconciling");
    expect(effect).not.toHaveBeenCalled();
  },
);
