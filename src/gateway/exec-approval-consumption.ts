import { ApprovalMutationRefusedError } from "./exec-approval-authority.js";
import {
  EXEC_APPROVAL_RESOLVED_ENTRY_GRACE_MS,
  prepareExecApprovalRedemptionWindow,
} from "./exec-approval-lifecycle.js";
import type {
  ExecApprovalManagerOptions,
  ExecApprovalRecord,
} from "./exec-approval-manager.types.js";
import {
  assertExecApprovalMutationPersistenceCurrent,
  captureExecApprovalMutationPersistence,
} from "./exec-approval-recovery.js";
import type { OperatorApprovalKind } from "./operator-approval-store.js";
import type { ExecApprovalPreparedConsumption } from "./operator-approval-store.types.js";

/** Prepare consumption using the manager's exact live binding and grace lifecycle. */
export function prepareExecApprovalConsumption<TPayload>(params: {
  id: string;
  record: ExecApprovalRecord<TPayload>;
  consumerId: string;
  kind: OperatorApprovalKind;
  persistence: ExecApprovalManagerOptions<TPayload>["persistence"];
  isCurrent: () => boolean;
  resolvedGraceAnchorMs: (nowMs: number) => number | null;
}): ExecApprovalPreparedConsumption | null {
  if (!params.isCurrent() || params.record.consumedDecision !== undefined) {
    return null;
  }
  const nowMs = Date.now();
  const redemptionWindowMs = prepareExecApprovalRedemptionWindow(
    params.record,
    params.resolvedGraceAnchorMs(nowMs),
    nowMs,
  );
  if (redemptionWindowMs === null) {
    return null;
  }
  const persistence = captureExecApprovalMutationPersistence(params.persistence);
  const databasePath = persistence.workerContext?.admission.databasePath;
  if (!databasePath) {
    throw new Error("Approval consumption has no captured database owner");
  }
  const input = Object.freeze({
    id: params.id,
    nowMs,
    consumerId: params.consumerId,
    expectedKind: params.kind,
    runtimeEpoch: params.persistence.runtimeEpoch,
    redemptionWindowMs,
  });
  return {
    input,
    databasePath,
    assertCurrent: () => {
      assertExecApprovalMutationPersistenceCurrent(persistence);
      const currentNowMs = Date.now();
      const currentGraceAnchorMs = params.resolvedGraceAnchorMs(currentNowMs);
      if (
        !params.isCurrent() ||
        params.record.consumedDecision !== undefined ||
        currentGraceAnchorMs === null ||
        currentNowMs - currentGraceAnchorMs >= EXEC_APPROVAL_RESOLVED_ENTRY_GRACE_MS
      ) {
        throw new ApprovalMutationRefusedError("approval authority is no longer active");
      }
    },
    markCommitted: (record) => {
      if (
        record.id !== input.id ||
        record.kind !== input.expectedKind ||
        record.runtimeEpoch !== input.runtimeEpoch ||
        record.status !== "allowed" ||
        record.decision !== "allow-once" ||
        record.consumedAtMs === null ||
        record.consumedBy !== input.consumerId
      ) {
        throw new Error("Committed approval consumption differs from its live owner");
      }
      // Commit is authoritative even if cancellation arrives before its publication.
      params.record.consumedDecision = "allow-once";
      params.record.consumedAtMs = record.consumedAtMs;
      params.record.consumedBy = record.consumedBy;
    },
  };
}
