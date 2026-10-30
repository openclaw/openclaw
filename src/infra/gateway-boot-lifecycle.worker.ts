import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { WorkerOperationHandlers } from "../state/worker-operation-registry.js";
import type { GatewayBootLifecycleCompletion } from "./gateway-boot-lifecycle.js";
import {
  GATEWAY_CRASH_LOOP_BREAKER_REASON,
  GATEWAY_CRASH_LOOP_RECOVERED_REASON,
  buildGatewayCrashLoopBreakerDecision,
  GATEWAY_SIGNAL_REPEAT_WINDOW_MS,
  inspectGatewayCrashLoopBreakerInDatabase,
} from "./gateway-boot-lifecycle.kernel.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

type GatewayBootLifecycleDatabase = Pick<DB, "gateway_boot_lifecycle">;

// Keep forensic history longer than the crash-loop window.
const GATEWAY_BOOT_LIFECYCLE_RETENTION_MS = 24 * 60 * 60_000;
const gatewayLifecycleLog = createSubsystemLogger("gateway/lifecycle");

export const gatewayBootOperations = {
  "gatewayBoot.begin": (nowMs: number, context) => {
    let decision = buildGatewayCrashLoopBreakerDecision({ uncleanBoots: 0 });
    try {
      decision = inspectGatewayCrashLoopBreakerInDatabase(context.open().db, nowMs);
    } catch (err) {
      gatewayLifecycleLog.warn(`crash-loop breaker state unavailable; fail-open: ${String(err)}`);
    }
    const reason = decision.tripped
      ? decision.shouldWriteStabilityBundle
        ? GATEWAY_CRASH_LOOP_BREAKER_REASON
        : undefined
      : decision.recovered
        ? GATEWAY_CRASH_LOOP_RECOVERED_REASON
        : undefined;
    const id = randomUUID();
    try {
      runOpenClawStateWriteTransaction(({ db }) => {
        const kysely = getNodeSqliteKysely<GatewayBootLifecycleDatabase>(db);
        executeSqliteQuerySync(
          db,
          kysely
            .deleteFrom("gateway_boot_lifecycle")
            .where("started_at_ms", "<", nowMs - GATEWAY_BOOT_LIFECYCLE_RETENTION_MS),
        );
        executeSqliteQuerySync(
          db,
          kysely.insertInto("gateway_boot_lifecycle").values({
            boot_id: id,
            pid: process.pid,
            started_at_ms: nowMs,
            completed_at_ms: null,
            outcome: null,
            startup_reason: reason ?? null,
            reason: null,
          }),
        );
      }, context.stateOptions());
      return { decision, id };
    } catch (err) {
      // A failed history append must not discard an already-tripped breaker decision.
      gatewayLifecycleLog.warn(`failed to persist gateway boot start; fail-open: ${String(err)}`);
      return { decision, id: undefined };
    }
  },
  "gatewayBoot.complete": (
    input: {
      bootId: string;
      completion: GatewayBootLifecycleCompletion;
      nowMs: number;
      countSignalStops: boolean;
    },
    context,
  ) =>
    runOpenClawStateWriteTransaction(({ db }) => {
      const { bootId, completion, nowMs } = input;
      const kysely = getNodeSqliteKysely<GatewayBootLifecycleDatabase>(db);
      executeSqliteQuerySync(
        db,
        kysely
          .updateTable("gateway_boot_lifecycle")
          .set({
            completed_at_ms: nowMs,
            outcome: completion.outcome,
            ...(completion.startupReason ? { startup_reason: completion.startupReason } : {}),
            reason: completion.reason ?? null,
          })
          .where("boot_id", "=", bootId),
      );
      return input.countSignalStops
        ? executeSqliteQueryTakeFirstSync(
            db,
            kysely
              .selectFrom("gateway_boot_lifecycle")
              .select((eb) => eb.fn.countAll<number>().as("count"))
              .where("outcome", "=", "clean_stop")
              .where("reason", "=", completion.reason ?? null)
              .where("completed_at_ms", ">=", nowMs - GATEWAY_SIGNAL_REPEAT_WINDOW_MS),
          )?.count
        : undefined;
    }, context.stateOptions()),
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
