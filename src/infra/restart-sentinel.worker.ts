import { isRecord as isPlainRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  WorkerWriteOperationContext,
  WorkerOperationHandlers,
} from "../state/worker-operation-registry.js";
import { gitCommitPrefixesMatch } from "./git-commit.js";
import type { RestartSentinelPayload } from "./restart-sentinel-codec.js";
import {
  deleteRestartSentinelRowSync,
  recordManagedHandoffSentinelOutcomeRowSync,
  readRestartSentinelRowSync,
  readRestartSentinelSnapshotSync,
  writeRestartSentinelRowIfRevisionSync,
  writeRestartSentinelRowSync,
  writeUpdateInstallReceiptRowSync,
  type RestartSentinel,
  type ManagedHandoffSentinelOutcome,
} from "./restart-sentinel-store.js";
import type { EngineConnection } from "./sql-connection.js";

function transaction<Input, Output>(
  label: string,
  operation: (db: EngineConnection, input: Input) => Output,
) {
  return (input: Input, { writeAdmitted }: WorkerWriteOperationContext): Output =>
    writeAdmitted(({ db }) => operation(db, input), { operationLabel: label });
}

export const restartSentinelOperations = {
  "restartSentinel.managedHandoffOutcome": transaction(
    "restart-sentinel.managed-handoff-outcome",
    (db, input: ManagedHandoffSentinelOutcome) =>
      recordManagedHandoffSentinelOutcomeRowSync(db, input),
  ),
  "restartSentinel.admit": (_input: undefined, { open }) => {
    open();
  },
  "restartSentinel.write": transaction(
    "restart-sentinel.write",
    (db, payload: RestartSentinelPayload) => writeRestartSentinelRowSync(db, payload),
  ),
  "restartSentinel.writeIfUnchanged": transaction(
    "restart-sentinel.write-if-unchanged",
    (db, input: { payload: RestartSentinelPayload; expectedRevision: number | null }) => {
      const current = readRestartSentinelSnapshotSync(db);
      return current.state.kind !== "invalid" && current.revision === input.expectedRevision
        ? writeRestartSentinelRowSync(db, input.payload, current.revision)
        : null;
    },
  ),
  "restartSentinel.markFailure": transaction(
    "restart-sentinel.mark-failure",
    (db, input: { reason: string; expectedOwner?: { runId?: string; handoffId?: string } }) => {
      const current = readRestartSentinelRowSync(db);
      if (current.kind !== "valid") {
        return null;
      }
      const payload = current.sentinel.payload;
      if (
        payload.kind !== "update" ||
        (input.expectedOwner?.runId !== undefined &&
          payload.stats?.runId !== input.expectedOwner.runId) ||
        (input.expectedOwner?.handoffId !== undefined &&
          payload.stats?.handoffId !== input.expectedOwner.handoffId)
      ) {
        return null;
      }
      delete payload.continuation;
      payload.status = "error";
      payload.stats = { ...payload.stats, reason: input.reason };
      return writeRestartSentinelRowIfRevisionSync(db, payload, current.sentinel.revision);
    },
  ),
  "restartSentinel.clear": transaction(
    "restart-sentinel.clear-if-revision",
    deleteRestartSentinelRowSync,
  ),
  "restartSentinel.finalize": transaction(
    "restart-sentinel.finalize-running-install",
    (
      db,
      input: {
        expectedRevision: number;
        version: string;
        commit?: string | null;
        expectedRoot: string | null;
        actualRoot: string | null;
      },
    ) => {
      const { version, commit, expectedRoot, actualRoot } = input;
      const current = readRestartSentinelRowSync(db);
      if (
        current.kind !== "valid" ||
        current.sentinel.revision !== input.expectedRevision ||
        current.sentinel.payload.kind !== "update"
      ) {
        return { sentinel: null, installReceipt: null };
      }

      const payload = current.sentinel.payload;
      const stats = payload.stats ? { ...payload.stats } : {};
      const after = isPlainRecord(stats.after) ? { ...stats.after } : {};
      let changed = false;
      if (after.version !== version) {
        after.version = version;
        changed = true;
      }
      if (expectedRoot && stats.root !== expectedRoot) {
        stats.root = expectedRoot;
        changed = true;
      }

      const before = isPlainRecord(stats.before) ? stats.before : {};
      const beforeSha = typeof before.sha === "string" ? before.sha.trim() : "";
      const expectedSha = typeof after.sha === "string" ? after.sha.trim() : "";
      const actualSha = commit?.trim() ?? "";
      const verifiesGitRevision =
        stats.mode !== "git" ||
        (expectedSha.length > 0 && gitCommitPrefixesMatch(expectedSha, actualSha));
      const verifiesInstallRoot =
        expectedRoot !== null && actualRoot !== null && expectedRoot === actualRoot;
      const changedInstall =
        stats.mode !== "git" ||
        (beforeSha.length > 0 &&
          expectedSha.length > 0 &&
          !gitCommitPrefixesMatch(beforeSha, expectedSha));
      if (payload.status === "ok" && expectedRoot && !verifiesInstallRoot) {
        payload.status = "error";
        stats.reason = actualRoot ? "restart-root-mismatch" : "restart-root-unavailable";
        delete payload.continuation;
        changed = true;
      } else if (
        payload.status === "ok" &&
        stats.mode === "git" &&
        expectedSha &&
        !verifiesGitRevision
      ) {
        payload.status = "error";
        stats.reason = actualSha ? "restart-revision-mismatch" : "restart-revision-unavailable";
        delete payload.continuation;
        changed = true;
      }

      stats.after = after;
      payload.stats = stats;
      const finalized = changed
        ? writeRestartSentinelRowIfRevisionSync(db, payload, current.sentinel.revision)
        : current.sentinel;
      if (!finalized) {
        return { sentinel: null, installReceipt: null };
      }
      return {
        sentinel: changed ? finalized : null,
        installReceipt:
          stats.mode === "git" && verifiesInstallRoot && verifiesGitRevision && changedInstall
            ? finalized
            : null,
      };
    },
  ),
  "restartSentinel.recordInstall": transaction(
    "restart-sentinel.record-install",
    (db, receipt: RestartSentinel) => {
      const current = readRestartSentinelRowSync(db);
      if (current.kind === "valid" && current.sentinel.revision === receipt.revision) {
        writeUpdateInstallReceiptRowSync(db, receipt.payload);
      }
    },
  ),
} satisfies WorkerOperationHandlers<WorkerWriteOperationContext>;
