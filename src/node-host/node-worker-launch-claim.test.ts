import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

describe("node worker launch claim postimages", () => {
  it.each(["insert", "reclaim"] as const)(
    "returns the %s postimage with one authoritative launch read",
    (operation) => {
      const env = { OPENCLAW_STATE_DIR: tempDirs.make("node-worker-launch-claim-") };
      const opened = openOpenClawStateDatabase({ env });
      const db = opened.db;
      const kernel = new NodeWorkerLaunchKernel({ database: opened, env });
      const admission = vi
        .spyOn(operationAdmission, "requestSqliteWorkerOperationAdmission")
        .mockImplementation(() => {});
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
      try {
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
        expect(kernel.get(claim.launchId)).toEqual(result.receipt);
      } finally {
        admission.mockRestore();
      }
    },
  );
});
