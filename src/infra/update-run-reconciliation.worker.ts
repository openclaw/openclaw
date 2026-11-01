import { runExistingOpenClawStateWriteTransaction } from "../state/openclaw-state-db-existing-write.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import { inspectNewerRecoveryHistory, needsPostCoreRepair } from "./update-run-activity.js";
import type { UpdateRunLedgerOptions } from "./update-run-codec.js";
import { readInstalledUpdateCandidate } from "./update-run-interruption-store.js";
import { LEGACY_UPDATE_RUN_EXPIRED_REASON } from "./update-run-legacy-expiry.js";
import {
  canReconcileUpdateRunCandidates,
  readUpdateRunRecord,
  readUpdateRuns,
} from "./update-run-read.kernel.js";
import { inspectUpdateRunReconciliation } from "./update-run-reconciliation.read.js";
import type {
  UpdateRunReconciliationOperations,
  UpdateRunReconciliationResult,
} from "./update-run-reconciliation.types.js";
import { finishUpdateRunRecord, type UpdateRunRecord } from "./update-run-record.js";
import { persistRun, updateRunLedgerSchema as schema, upsertStep } from "./update-run-write.js";

type LedgerDatabase = Pick<DB, "update_runs">;

function recordedServingCandidate(record: UpdateRunRecord): UpdateRunRecord["after"] | undefined {
  const { verification } = record;
  const installed = readInstalledUpdateCandidate(record);
  const version =
    installed?.version ??
    record.after.version ??
    record.origin.admission?.candidateVersion ??
    record.target.version;
  const buildId = installed?.buildId ?? record.after.buildId;
  // Released Gateway observers can record the serving candidate before the
  // orchestrator completes its step. Recovery's matching previous version is not success.
  if (
    !["activating", "restarting", "verifying"].includes(record.phase) ||
    record.reason ||
    record.repair.length ||
    verification.recovery ||
    verification.rollbackOutcome ||
    verification.booted !== true ||
    verification.serviceRunning !== true ||
    verification.versionMatch !== true ||
    (verification.coreReady ?? verification.readyz) === false ||
    verification.settled === false ||
    !version ||
    verification.runningVersion !== version ||
    (buildId && verification.runningBuildId !== buildId) ||
    record.steps.some(
      (step) =>
        step.status === "failed" ||
        step.step === "driver:identity-unavailable" ||
        step.step === "package rollback" ||
        step.step === "previous generation restoration",
    )
  ) {
    return undefined;
  }
  return {
    version,
    ...(verification.runningBuildId ? { buildId: verification.runningBuildId } : {}),
  };
}

export function reconcileUpdateRunCandidatesInWorker(
  command: UpdateRunReconciliationOperations["updateRuns.reconcile"]["input"],
  stateOptions: UpdateRunLedgerOptions,
  assertCurrent: (stage: "transaction" | "commit") => void,
): UpdateRunReconciliationResult {
  const { candidates, selection: input, busyTimeoutMs, redactPaths } = command;
  const options = { ...stateOptions, busyTimeoutMs, redactPaths };
  assertCurrent("transaction");
  return runExistingOpenClawStateWriteTransaction(
    ({ db }) => {
      const selected = candidates.flatMap(({ record }) => {
        const current = readUpdateRunRecord(db, record.runId);
        return current ? [inspectUpdateRunReconciliation(db, current, input)] : [];
      });
      const current = selected.map(({ record }) => record);
      if (input.repairHistorySinceMs !== undefined) {
        const history = inspectNewerRecoveryHistory(
          input.repairHistorySinceMs,
          readUpdateRuns(db, { limit: 100 }),
        );
        if (
          current.some((record) => record.status === "running" && needsPostCoreRepair(record)) ||
          history.postCoreRuns.length ||
          history.incomplete
        ) {
          throw new Error(
            "Update history changed during inspection and now needs post-core maintenance. Retry openclaw update repair; if the managed Gateway cannot stop, run openclaw gateway stop first.",
          );
        }
      }
      if (
        !canReconcileUpdateRunCandidates(selected, input) ||
        (input.requireAllActive &&
          executeSqliteQueryTakeFirstSync(
            db,
            getNodeSqliteKysely<LedgerDatabase>(db)
              .selectFrom("update_runs")
              .select("run_id")
              .where("status", "=", "running")
              .where(
                "run_id",
                "not in",
                candidates.map(({ record }) => record.runId),
              )
              .limit(1),
          ))
      ) {
        assertCurrent("commit");
        return { current, reconciled: [] };
      }
      const reconciled: UpdateRunRecord[] = [];
      for (const [index, { record, rule }] of selected.entries()) {
        if (
          !rule ||
          (input.legacyOnly && rule !== LEGACY_UPDATE_RUN_EXPIRED_REASON) ||
          (input.statusOnly &&
            rule !== LEGACY_UPDATE_RUN_EXPIRED_REASON &&
            rule !== "handoff-terminated")
        ) {
          continue;
        }
        const serving =
          rule === "inactive-driver-dead" || rule === "handoff-terminated"
            ? recordedServingCandidate(record)
            : undefined;
        if (serving) {
          upsertStep(record, {
            step: "warning:reconcile:driver-lost-after-verification",
            status: "completed",
            endedAtMs: Date.now(),
            detail: `Update driver was lost after recorded verification of installed and serving candidate ${serving.version} (${rule}). Completion bookkeeping and follow-up work may be incomplete; saved verification describes the update attempt, not current Gateway health.`,
          });
          finishUpdateRunRecord(record, { status: "succeeded", after: serving });
        } else {
          upsertStep(record, {
            step: "reconcile:abandoned",
            status: "failed",
            endedAtMs: Date.now(),
            detail:
              rule === "handoff-terminated"
                ? `Managed handoff terminated during ${record.phase}; last recorded phase: ${record.phase}. Check the handoff log and systemd journal for termination or OOM diagnostics.`
                : rule,
          });
          finishUpdateRunRecord(record, {
            status: "failed",
            reason:
              rule === LEGACY_UPDATE_RUN_EXPIRED_REASON || rule === "handoff-terminated"
                ? rule
                : "abandoned",
            nextAction: "Run `openclaw update repair` before retrying the update.",
          });
        }
        const saved = persistRun(db, record, options);
        current[index] = saved;
        reconciled.push(saved);
      }
      assertCurrent("commit");
      return { current, reconciled };
    },
    options,
    { schemaSql: schema, operationLabel: "update.run", busyTimeoutMs: options.busyTimeoutMs },
  );
}
