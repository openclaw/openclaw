import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { computeBackoff } from "../infra/backoff.js";
import type { ExecApprovalDecision } from "../infra/exec-approvals.js";
import { isSqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { isExecApprovalMutationRefused } from "./exec-approval-authority.js";
import { ExecApprovalLifecycle, type PendingEntry } from "./exec-approval-lifecycle.js";
import type {
  ExecApprovalForceDenyResult,
  ExecApprovalManagerOptions,
  ExecApprovalReadAuthority,
} from "./exec-approval-manager.types.js";
import {
  assertExecApprovalMutationPersistenceCurrent,
  captureExecApprovalMutationPersistence,
} from "./exec-approval-recovery.js";
import type {
  OperatorApprovalResolver,
  OperatorApprovalTerminalReason,
  OperatorApprovalStoreGuard,
} from "./operator-approval-store.types.js";

/** The existing pending entry owns its deadline and any definite-refusal retry. */
export abstract class ExecApprovalExpiry<TPayload> extends ExecApprovalLifecycle<TPayload> {
  protected abstract override readonly options: Pick<
    ExecApprovalManagerOptions<TPayload>,
    "persistence" | "onError" | "onExpired" | "onLifecycle"
  >;
  abstract forceDenyDetailed(
    recordId: string,
    reason: OperatorApprovalTerminalReason,
    resolver: OperatorApprovalResolver,
    status?: "denied" | "expired" | "cancelled",
    localDecision?: ExecApprovalDecision | null,
    requireDue?: boolean,
    localResolvedBy?: string | null,
    assertResolverCurrent?: () => void,
    callerGuard?: OperatorApprovalStoreGuard,
  ): Promise<ExecApprovalForceDenyResult<TPayload>>;

  protected override scheduleExpiryTimer(
    entry: PendingEntry<TPayload>,
    delayMs = entry.record.expiresAtMs - Date.now(),
  ): void {
    if (
      this.retired ||
      entry.record.resolvedAtMs !== undefined ||
      this.pending.get(entry.record.id) !== entry
    ) {
      return;
    }
    clearTimeout(entry.timer ?? undefined);
    const timer = setTimeout(
      () => {
        if (this.retired || this.pending.get(entry.record.id) !== entry || entry.timer !== timer) {
          return;
        }
        entry.timer = null;
        void this.expireDue(entry.record.id).catch((error: unknown) => {
          this.reportError(error, { approvalId: entry.record.id, operation: "expire" });
        });
      },
      resolveTimerTimeoutMs(delayMs, 1),
    );
    entry.timer = timer;
  }

  protected override async expireDue(
    recordId: string,
    authority?: ExecApprovalReadAuthority,
  ): Promise<boolean> {
    authority?.assertCurrent();
    if (this.retired) {
      return false;
    }
    const entry = this.pending.get(recordId);
    if (!entry || entry.record.resolvedAtMs !== undefined) {
      return false;
    }
    this.assertPendingPersistenceCurrent(entry);
    let persistence = entry.expiryPersistence;
    let result: ExecApprovalForceDenyResult<TPayload>;
    try {
      persistence ??= captureExecApprovalMutationPersistence(this.options.persistence);
      entry.expiryPersistence = persistence;
      result = await this.forceDenyDetailed(
        recordId,
        "timeout",
        { kind: "system", id: null },
        "expired",
        undefined,
        true,
        null,
        undefined,
        authority?.guard,
      );
    } catch (error) {
      if (!persistence && !isExecApprovalMutationRefused(error)) {
        this.settleLocalStorageFailure(recordId);
      }
      // Only canonical pre-execution refusals can replay the timeout CAS. Cleanup
      // aggregates and lost replies retain their existing outcome-unknown recovery.
      if (
        persistence &&
        (isSqliteWorkerError(error, "overloaded") || isSqliteWorkerError(error, "unavailable"))
      ) {
        assertExecApprovalMutationPersistenceCurrent(persistence);
        this.assertPendingPersistenceCurrent(entry);
        entry.expiryRefusals = (entry.expiryRefusals ?? 0) + 1;
        this.scheduleExpiryTimer(
          entry,
          computeBackoff(
            { initialMs: 1_000, maxMs: 30_000, factor: 2, jitter: 0.1 },
            entry.expiryRefusals,
          ),
        );
      }
      throw error;
    }
    authority?.assertCurrent();
    if (result.outcome === "not-due") {
      this.scheduleExpiryTimer(entry);
      return false;
    }
    return result.outcome === "denied" || result.outcome === "expired";
  }
}
