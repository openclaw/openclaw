import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { updateConfigMachineStateInDatabase, writeConfigMachineStateInDatabase } from "../state/config-machine-state-write.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { WorkerOperationHandlers } from "../state/worker-operation-registry.js";
import type {
  GatewayBootLifecycleCompletion,
  GatewayBootLifecycleStart,
  GatewayRestartResumeWindow,
  GatewayRestartResumeWindows,
} from "./gateway-boot-lifecycle.js";
import {
  GATEWAY_CRASH_LOOP_BREAKER_REASON,
  GATEWAY_CRASH_LOOP_RECOVERED_REASON,
  buildGatewayCrashLoopBreakerDecision,
  GATEWAY_SIGNAL_REPEAT_WINDOW_MS,
  inspectGatewayCrashLoopBreakerInDatabase,
  readGatewayCrashStateInDatabase,
} from "./gateway-boot-lifecycle.kernel.js";
import {
  GATEWAY_CRASH_STATE_KEY,
  type GatewayCrashEvidence,
  type GatewayCrashRecord,
  type GatewayRunMetadata,
} from "./gateway-crash.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

type GatewayBootLifecycleDatabase = Pick<DB, "gateway_boot_lifecycle" | "agent_databases">;

// Keep forensic history longer than the crash-loop window.
const GATEWAY_BOOT_LIFECYCLE_RETENTION_MS = 24 * 60 * 60_000;
const RESTART_RECOVERY_KEY = "gateway.restartRecovery";
const gatewayLifecycleLog = createSubsystemLogger("gateway/lifecycle");

export const gatewayBootOperations = {
  "gatewayBoot.begin": (
    input: {
      nowMs: number;
      metadata: GatewayRunMetadata;
      previousOwner?: { pid: number; heartbeatAt?: number };
    },
    context,
  ): GatewayBootLifecycleStart & { crashes?: GatewayCrashRecord[] } => {
    const { nowMs, metadata, previousOwner } = input;
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
      const recorded = runOpenClawStateWriteTransaction(({ db }) => {
        const kysely = getNodeSqliteKysely<GatewayBootLifecycleDatabase>(db);
        const boots = kysely
          .selectFrom("gateway_boot_lifecycle")
          .select(["boot_id", "pid", "started_at_ms", "outcome", "startup_reason", "reason"]);
        const predecessor = executeSqliteQueryTakeFirstSync(
          db,
          boots.orderBy("started_at_ms", "desc").limit(1),
        );
        let window: GatewayRestartResumeWindow | undefined;
        const crashState = readGatewayCrashStateInDatabase(db);
        let previousCrash: GatewayCrashRecord | undefined;
        // Forced exit can interrupt marker persistence just like a process crash.
        if (
          predecessor &&
          (predecessor.outcome === null || predecessor.outcome === "forced_stop")
        ) {
          let previous: NonNullable<typeof predecessor> = predecessor;
          // A safe-mode recovery splits one incarnation; a real restart can reuse its PID.
          while (previous.startup_reason === GATEWAY_CRASH_LOOP_RECOVERED_REASON) {
            const parent = executeSqliteQueryTakeFirstSync(
              db,
              boots
                .where("pid", "=", previous.pid)
                .where("outcome", "=", "safe_mode_stable")
                .where("completed_at_ms", "=", previous.started_at_ms)
                .where("started_at_ms", "<", previous.started_at_ms)
                .orderBy("started_at_ms", "desc")
                .limit(1),
            );
            if (!parent) {
              break;
            }
            previous = parent;
          }
          window = { startedAt: previous.started_at_ms, endedAt: nowMs };
        }
        if (
          predecessor &&
          (predecessor.outcome === null ||
            predecessor.outcome === "forced_stop" ||
            predecessor.outcome === "startup_failed")
        ) {
          const run =
            crashState.active?.bootId === predecessor.boot_id ? crashState.active : undefined;
          const heartbeat =
            previousOwner?.pid === predecessor.pid ? previousOwner.heartbeatAt : undefined;
          previousCrash = {
            ...run,
            bootId: predecessor.boot_id,
            pid: predecessor.pid,
            startedAtMs: window?.startedAt ?? predecessor.started_at_ms,
            detectedAtMs: nowMs,
            ...(predecessor.reason ? { reason: predecessor.reason } : {}),
            ...(heartbeat !== undefined &&
            heartbeat >= (window?.startedAt ?? predecessor.started_at_ms) &&
            heartbeat <= nowMs
              ? { lastHeartbeatAtMs: heartbeat }
              : {}),
          };
          crashState.recent = [previousCrash, ...crashState.recent].slice(0, 10);
        }
        crashState.active = { ...metadata, bootId: id, pid: process.pid };
        writeConfigMachineStateInDatabase(db, GATEWAY_CRASH_STATE_KEY, crashState);
        // Read the predecessor before pruning: a long-running boot can exceed retention.
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
        // Registration precedes every durable run, including shared stores and refused schemas.
        // Keep exact intervals until that physical agent completes recovery, across clean boots.
        const owners = executeSqliteQuerySync(
          db,
          kysely.selectFrom("agent_databases").select("agent_id").distinct(),
        ).rows;
        const restartResumeWindows =
          updateConfigMachineStateInDatabase<GatewayRestartResumeWindows>(
            db,
            RESTART_RECOVERY_KEY,
            (pending = {}) => {
              const retained = Object.fromEntries<GatewayRestartResumeWindow[]>(
                owners.flatMap(({ agent_id: agentId }) => {
                  const windows = Object.hasOwn(pending, agentId) ? pending[agentId]! : [];
                  if (window) {
                    const last = windows.at(-1);
                    if (last && last.endedAt === window.startedAt) {
                      last.endedAt = window.endedAt;
                    } else {
                      windows.push(window);
                    }
                  }
                  return windows.length ? [[agentId, windows]] : [];
                }),
              );
              return Object.keys(retained).length ? retained : undefined;
            },
            nowMs,
          );
        return { restartResumeWindow: window, restartResumeWindows, previousCrash, crashes: crashState.recent };
      }, context.stateOptions());
      return { decision, id, ...recorded };
    } catch (err) {
      // A failed history append must not discard an already-tripped breaker decision.
      gatewayLifecycleLog.warn(`failed to persist gateway boot start; fail-open: ${String(err)}`);
      return { decision, id: undefined };
    }
  },
  "gatewayBoot.recoveredAgent": (input: { agentId: string; through: number }, context) =>
    runOpenClawStateWriteTransaction(({ db }) => {
      updateConfigMachineStateInDatabase<GatewayRestartResumeWindows>(
        db,
        RESTART_RECOVERY_KEY,
        (pending) => {
          if (!pending || !Object.hasOwn(pending, input.agentId)) {
            return pending;
          }
          const remaining = pending[input.agentId]?.filter(
            (window) => window.endedAt > input.through,
          );
          if (remaining?.length) {
            pending[input.agentId] = remaining;
          } else {
            delete pending[input.agentId];
          }
          return Object.keys(pending).length ? pending : undefined;
        },
        Date.now(),
      );
    }, context.stateOptions()),
  "gatewayBoot.enrichCrash": (input: { bootId: string; evidence: GatewayCrashEvidence }, context) =>
    runOpenClawStateWriteTransaction(({ db }) => {
      const state = readGatewayCrashStateInDatabase(db);
      const crash = state.recent.find((record) => record.bootId === input.bootId);
      if (crash) {
        Object.assign(crash, input.evidence);
        writeConfigMachineStateInDatabase(db, GATEWAY_CRASH_STATE_KEY, state);
      }
      return { crash, crashes: state.recent };
    }, context.stateOptions()),
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
      const crashState = readGatewayCrashStateInDatabase(db);
      if (crashState.active && crashState.active.bootId === input.bootId) {
        crashState.active.bootId = recoveredBootId;
        writeConfigMachineStateInDatabase(db, GATEWAY_CRASH_STATE_KEY, crashState);
      }
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
