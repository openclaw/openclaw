import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import * as operationAdmission from "../infra/sqlite-worker-operation-admission.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { NodeWorkerLaunchKernel } from "./node-worker-launch-store.kernel.js";
import { requireNodeWorkerProcessIdentity } from "./node-worker-process-identity.js";

const NOW_MS = 10 * 24 * 60 * 60 * 1_000;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

function fixture() {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("node-worker-launch-claim-") };
  const opened = openOpenClawStateDatabase({ env });
  const kernel = new NodeWorkerLaunchKernel({ database: opened, env });
  vi.spyOn(operationAdmission, "requestSqliteWorkerOperationAdmission").mockImplementation(
    () => {},
  );
  const previous = requireNodeWorkerProcessIdentity(process.pid);
  const supervisor = { pid: previous.pid, startTime: previous.startTime + 1 };
  const claim = {
    launchId: "count-launch",
    planHash: "a".repeat(64),
    gatewayNamespace: "gateway-1",
    environmentId: "environment-1",
    sessionId: "session-1",
    ownerEpoch: 3,
    placementGeneration: 4,
    runId: "run-1",
  };
  return { ...opened, kernel, previous, supervisor, claim };
}

describe("node worker launch claim postimages", () => {
  it.each(["insert", "reclaim"] as const)(
    "returns the %s postimage with one authoritative launch read",
    (operation) => {
      const { db, kernel, previous, supervisor, claim } = fixture();
      // Admit the optional boot table before measuring either branch.
      kernel.claim(claim, previous, 10, NOW_MS + 7, undefined, undefined, "old-boot");
      if (operation === "insert") {
        claim.launchId = "new-count-launch";
      }
      const observed = kernel.claimObservation(claim, supervisor, 10, NOW_MS);
      const reads = trackSqliteStatementExecutions(
        requireNativeSqliteDatabase(db),
        ["launch"],
        (sql) =>
          sql.startsWith("select ") &&
          sql.includes('from "node_worker_launches"') &&
          sql.includes('where "node_worker_launches"."launch_id" =')
            ? "launch"
            : null,
      );
      let result: ReturnType<NodeWorkerLaunchKernel["claim"]>;
      try {
        result = kernel.claim(claim, supervisor, 10, NOW_MS, observed, "reused", "new-boot");
        expect.soft(reads.counts.launch).toBe(1);
      } finally {
        reads.restore();
      }
      expect(result).toMatchObject({
        action: "start",
        receipt: {
          launchId: claim.launchId,
          state: "pending",
          supervisor,
          bootId: "new-boot",
          updatedAtMs: operation === "insert" ? NOW_MS : NOW_MS + 7,
        },
      });
      expect(result).toEqual({
        action: "start",
        nonterminalCount: operation === "insert" ? 2 : 1,
        receipt: kernel.get(claim.launchId),
      });
    },
  );

  it.each([undefined, null, ""])(
    "does not create absent boot metadata (%s) on reclaim",
    (bootId) => {
      const { kernel, previous, supervisor, claim } = fixture();
      const created = kernel.claim(claim, previous, 10, NOW_MS + 7, undefined, undefined, bootId);
      expect(created).not.toHaveProperty("receipt.bootId");
      const observed = kernel.claimObservation(claim, supervisor, 10, NOW_MS);
      const result = kernel.claim(claim, supervisor, 10, NOW_MS, observed, "reused", "new-boot");
      expect(result).toMatchObject({
        action: "start",
        receipt: { supervisor, updatedAtMs: NOW_MS + 7 },
      });
      expect(result).not.toHaveProperty("receipt.bootId");
      expect(result).toEqual({
        action: "start",
        nonterminalCount: 1,
        receipt: kernel.get(claim.launchId),
      });
    },
  );

  it.each(["old-boot", null, undefined])(
    "preserves the physical row and current companions when reclaim matches no row (%s)",
    (bootId) => {
      const { path, kernel, previous, supervisor, claim } = fixture();
      kernel.claim(claim, previous, 10, NOW_MS, undefined, undefined, "old-boot");
      kernel.markRunning({
        ...claim,
        supervisor: previous,
        worker: previous,
        cleanupMode: "linux-subreaper",
        container: { engine: "docker", containerId: "b".repeat(64), engineTarget: "c".repeat(64) },
        nowMs: NOW_MS + 7,
      });
      const foreign = new (requireNodeSqlite().DatabaseSync)(path);
      try {
        foreign
          .prepare(
            "UPDATE node_worker_launches SET state = 'pending', worker_pid = NULL, worker_start_time = NULL WHERE launch_id = ?",
          )
          .run(claim.launchId);
        const observed = kernel.claimObservation(claim, supervisor, 10, NOW_MS);
        const container = {
          engine: "docker",
          containerId: "d".repeat(64),
          engineTarget: "e".repeat(64),
        };
        foreign
          .prepare(
            "UPDATE node_worker_launch_containers SET container_json = ? WHERE launch_id = ?",
          )
          .run(JSON.stringify(container), claim.launchId);
        foreign
          .prepare("UPDATE node_worker_launch_cleanup SET lineage_settled = 1 WHERE launch_id = ?")
          .run(claim.launchId);
        foreign
          .prepare(
            "UPDATE node_worker_launch_process_scopes SET descendants_reaped = 1 WHERE launch_id = ?",
          )
          .run(claim.launchId);
        if (bootId === undefined) {
          foreign
            .prepare("DELETE FROM node_worker_launch_boots WHERE launch_id = ?")
            .run(claim.launchId);
        } else {
          foreign
            .prepare("UPDATE node_worker_launch_boots SET boot_id = ? WHERE launch_id = ?")
            .run(bootId, claim.launchId);
        }
        // Suppress the physical write without creating a row that violates its CHECKs.
        foreign.exec(`CREATE TRIGGER skip_reclaim BEFORE UPDATE OF supervisor_pid
          ON node_worker_launches BEGIN SELECT RAISE(IGNORE); END`);
        const result = kernel.claim(
          claim,
          supervisor,
          10,
          NOW_MS + 20,
          observed,
          "reused",
          "new-boot",
        );
        expect(result).toMatchObject({
          action: "replay",
          nonterminalCount: 1,
          receipt: {
            state: "pending",
            supervisor: previous,
            worker: null,
            updatedAtMs: NOW_MS + 7,
            workerCleanupMode: "linux-subreaper",
            workerLineageSettled: true,
            workerDescendantsReaped: true,
            container,
          },
        });
        if (bootId) {
          expect(result).toHaveProperty("receipt.bootId", "new-boot");
        } else {
          expect(result).not.toHaveProperty("receipt.bootId");
        }
        expect(result).toEqual({
          action: "replay",
          nonterminalCount: 1,
          receipt: kernel.get(claim.launchId),
        });
      } finally {
        foreign.close();
      }
    },
  );
});
