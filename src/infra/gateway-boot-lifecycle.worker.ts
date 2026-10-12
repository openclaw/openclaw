import { randomUUID } from "node:crypto";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { WorkerOperationHandlers } from "../state/worker-operation-registry.js";
import {
  GATEWAY_CRASH_LOOP_RECOVERED_REASON,
  inspectGatewayCrashLoopBreakerInDatabase,
} from "./gateway-boot-lifecycle.kernel.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";

type GatewayBootLifecycleDatabase = Pick<DB, "gateway_boot_lifecycle">;

export const gatewayBootOperations = {
  "gatewayBoot.recover": (input: { bootId?: string; nowMs?: number }, context) =>
    runOpenClawStateWriteTransaction(({ db }) => {
      const nowMs = input.nowMs ?? Date.now();
      const decision = inspectGatewayCrashLoopBreakerInDatabase(db, nowMs);
      if (!decision.recovered || decision.uncleanBoots !== 0) {
        return undefined;
      }
      const kysely = getNodeSqliteKysely<GatewayBootLifecycleDatabase>(db);
      if (input.bootId) {
        const result = executeSqliteQuerySync(
          db,
          kysely
            .updateTable("gateway_boot_lifecycle")
            .set({ completed_at_ms: nowMs, outcome: "safe_mode_stable", reason: null })
            .where("boot_id", "=", input.bootId)
            .where("completed_at_ms", "is", null),
        );
        if (result.numAffectedRows !== 1n) {
          return undefined;
        }
      }
      const recoveredBootId = randomUUID();
      executeSqliteQuerySync(
        db,
        kysely.insertInto("gateway_boot_lifecycle").values({
          boot_id: recoveredBootId,
          pid: process.pid,
          started_at_ms: nowMs,
          completed_at_ms: null,
          outcome: null,
          startup_reason: GATEWAY_CRASH_LOOP_RECOVERED_REASON,
          reason: null,
        }),
      );
      return recoveredBootId;
    }, context.stateOptions()),
} satisfies WorkerOperationHandlers;
