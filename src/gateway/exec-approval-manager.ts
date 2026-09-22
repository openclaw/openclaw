import type { ExecApprovalDecision, ExecApprovalRequestPayload } from "../infra/exec-approvals.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import {
  EXEC_APPROVAL_RESOLVED_ENTRY_GRACE_MS,
  ExecApprovalLifecycle,
} from "./exec-approval-lifecycle.js";
import type {
  ExecApprovalDurableLookup,
  ExecApprovalForceDenyResult,
  ExecApprovalManagerOptions,
  ExecApprovalRecord,
  ExecApprovalResolutionSource,
  ExecApprovalResolveResult,
  OperatorApprovalLifecycleEvent,
} from "./exec-approval-manager.types.js";
import {
  createExecApprovalRecord,
  prepareExecApprovalPresentation,
  prepareExecApprovalRegistration,
} from "./exec-approval-registration.js";
import {
  prepareExecApprovalRedemptionWindow,
  prepareExecApprovalSettlement,
  prepareExecApprovalStandingGrant,
  prepareExecApprovalStorageFailure,
  projectClosedApprovalResolution,
  projectRepairedApprovalResolution,
} from "./exec-approval-results.js";
import {
  consumeOperatorApprovalAllowOnce,
  forceDenyOperatorApproval,
  getOperatorApprovalDetailed,
  insertOperatorApproval,
  resolveOperatorApproval,
  type ForceDenyOperatorApprovalResult,
  type OperatorApprovalKind,
  type OperatorApprovalRecord,
  type OperatorApprovalResolver,
  type OperatorApprovalTerminalReason,
  type ResolveOperatorApprovalResult,
} from "./operator-approval-store.js";

export { EXEC_APPROVAL_RESOLVED_ENTRY_GRACE_MS } from "./exec-approval-lifecycle.js";
export type {
  ExecApprovalIdLookupResult,
  ExecApprovalRecord,
  OperatorApprovalLifecycleEvent,
  OperatorStandingGrantMintSpec,
} from "./exec-approval-manager.types.js";

class ApprovalMutationRefusedError extends Error {}

/** Approval creation and persistence precede every local wait or delivery handoff. */
export class ExecApprovalManager<
  TPayload = ExecApprovalRequestPayload,
> extends ExecApprovalLifecycle<TPayload> {
  constructor(protected readonly options: ExecApprovalManagerOptions<TPayload>) {
    super();
  }

  get approvalKind(): OperatorApprovalKind {
    return this.options.approvalKind ?? "exec";
  }

  override get runtimeEpoch(): string {
    return this.options.persistence.runtimeEpoch;
  }

  create(request: TPayload, timeoutMs: number, id?: string | null): ExecApprovalRecord<TPayload> {
    this.assertNotRetired();
    return createExecApprovalRecord(request, timeoutMs, id);
  }

  /** Persist registration before exposing its separate decision promise to delivery. */
  async register(
    record: ExecApprovalRecord<TPayload>,
    _timeoutMs: number,
  ): Promise<{ decision: Promise<ExecApprovalDecision | null> }> {
    this.assertNotRetired();
    return this.trackMutation(async () => {
      const requestSignal = getAsyncWorkSignal();
      const assertCurrent = () => {
        requestSignal?.throwIfAborted();
        this.assertNotRetired();
        if (!this.isRuntimeAuthorityActive(record)) {
          throw new Error("approval authority is no longer active");
        }
      };
      assertCurrent();
      const persistence = this.options.persistence;
      const presentation = prepareExecApprovalPresentation(
        this.approvalKind,
        record.request,
        this.options.resolveAllowedDecisions?.(record.request),
      );
      const existing = this.pending.get(record.id);
      if (existing) {
        if (existing.record.resolvedAtMs === undefined) {
          return { decision: existing.promise };
        }
        throw new Error(`approval id '${record.id}' already resolved`);
      }

      const approval = await prepareExecApprovalRegistration({
        record,
        kind: this.approvalKind,
        presentation,
        runtimeEpoch: persistence.runtimeEpoch,
        resolveAudienceSessionKeys: this.options.resolveAudienceSessionKeys,
      });
      assertCurrent();
      const inserted = await insertOperatorApproval({
        approval,
        databaseOptions: persistence.databaseOptions,
        assertCurrent,
      });
      if (inserted.outcome === "conflict") {
        throw new Error(`approval id '${record.id}' conflicts with persisted state`);
      }
      this.assertNotRetired();
      const raced = this.pending.get(record.id);
      if (raced) {
        if (raced.record.resolvedAtMs === undefined) {
          return { decision: raced.promise };
        }
        throw new Error(`approval id '${record.id}' already resolved`);
      }
      const promise = this.registerEntry(record);
      for (const signal of record.approvalSignals ?? []) {
        if (signal.aborted) {
          this.scheduleAuthorityClosure(record.id);
          continue;
        }
        signal.addEventListener(
          "abort",
          () => {
            this.scheduleAuthorityClosure(record.id);
          },
          { once: true },
        );
      }
      if (inserted.outcome === "inserted") {
        this.emitLifecycle({ phase: "pending", record: inserted.record });
      }
      if (!this.isRuntimeAuthorityActive(record)) {
        this.scheduleAuthorityClosure(record.id);
      }
      return { decision: promise };
    });
  }

  private scheduleAuthorityClosure(recordId: string): void {
    void this.forceDenyIfRuntimeAuthorityClosed(recordId)
      .then((closed) => {
        if (closed?.outcome === "denied" && closed.liveRecord) {
          this.options.onExpired?.(closed.record, closed.liveRecord);
        }
      })
      .catch((error: unknown) => {
        this.reportError(error, { approvalId: recordId, operation: "expire" });
      });
  }

  private isRuntimeAuthorityActive(record: ExecApprovalRecord<TPayload>): boolean {
    const delegated = record.agentRuntimeDelegatedAuthority;
    if (
      (delegated && this.options.validateAgentRuntimeDelegatedAuthority?.(delegated) !== true) ||
      record.approvalSignals?.some((signal) => signal.aborted)
    ) {
      return false;
    }
    try {
      return record.approvalAuthority?.() !== false;
    } catch {
      return false;
    }
  }

  private emitLifecycle(event: OperatorApprovalLifecycleEvent): void {
    try {
      this.recordLifecyclePublication(event, this.options.onLifecycle !== undefined);
      this.options.onLifecycle?.(event);
    } catch {
      // Stream fanout is observational. It must never change approval truth or
      // prevent the durable first-answer transition from releasing its waiter.
    }
  }

  /** Persist the first verdict, then release the process-local waiter. */
  async resolveDetailed(
    recordId: string,
    decision: ExecApprovalDecision,
    resolver: OperatorApprovalResolver,
    localResolvedBy: string | null = null,
    localResolutionSource: ExecApprovalResolutionSource = "operator",
    options: {
      /** Explicit grant expiry override; undefined defers to the configured default. */
      grantExpiresAtMs?: number | null;
      assertCurrent?: () => void;
    } = {},
  ): Promise<ExecApprovalResolveResult<TPayload>> {
    if (this.retired) {
      return { outcome: "not-found" };
    }
    const capturedEntry = this.pending.get(recordId);
    if (
      decision !== "deny" &&
      capturedEntry &&
      !this.isRuntimeAuthorityActive(capturedEntry.record)
    ) {
      const closed = await this.forceDenyIfRuntimeAuthorityClosed(recordId);
      if (closed) {
        return projectClosedApprovalResolution(closed);
      }
    }
    return this.trackMutation(async () => {
      if (this.retired) {
        return { outcome: "not-found" };
      }
      const nowMs = Date.now();
      const localEntry = capturedEntry;
      const persistence = this.options.persistence;
      if (localEntry?.record.terminalReason === "storage-corrupt") {
        const repaired = await this.persistStorageCorruptDeny(recordId);
        return projectRepairedApprovalResolution(repaired, decision);
      }
      if (decision !== "deny" && !localEntry) {
        return { outcome: "not-found" };
      }

      const { standingGrantSpec, standingGrant } = prepareExecApprovalStandingGrant({
        decision,
        record: localEntry?.record,
        options: this.options,
        grantExpiresAtMs: options.grantExpiresAtMs,
      });
      let result: ResolveOperatorApprovalResult;
      try {
        result = await resolveOperatorApproval({
          id: recordId,
          nowMs,
          decision,
          resolver,
          expectedKind: this.approvalKind,
          runtimeEpoch: persistence.runtimeEpoch,
          databaseOptions: persistence.databaseOptions,
          assertCurrent: () => {
            this.assertNotRetired();
            try {
              options.assertCurrent?.();
            } catch (error) {
              throw new ApprovalMutationRefusedError(
                "approval resolver authority is no longer active",
                { cause: error },
              );
            }
            if (
              this.pending.get(recordId) !== localEntry ||
              (localEntry &&
                localEntry.record.expiresAtMs > nowMs &&
                localEntry.record.expiresAtMs <= Date.now()) ||
              (decision !== "deny" &&
                (!localEntry || !this.isRuntimeAuthorityActive(localEntry.record)))
            ) {
              throw new ApprovalMutationRefusedError("approval authority is no longer active");
            }
            if (
              standingGrantSpec &&
              localEntry &&
              (JSON.stringify(
                this.options.resolveStandingGrantMint?.(localEntry.record.request),
              ) !== JSON.stringify(standingGrantSpec) ||
                (standingGrantSpec.kind === "mcp-tool" &&
                  localEntry.record.mcpToolApprovalActive?.() !== true))
            ) {
              throw new ApprovalMutationRefusedError(
                "approval standing grant authority is no longer active",
              );
            }
          },
          ...(standingGrant?.kind === "cron" ? { standingGrant } : {}),
          ...(standingGrant?.kind === "mcp-tool" ? { mcpToolGrant: standingGrant } : {}),
        });
      } catch (error) {
        if (
          !(error instanceof ApprovalMutationRefusedError) &&
          !this.retired &&
          this.pending.get(recordId) === localEntry &&
          (!localEntry ||
            (this.isRuntimeAuthorityActive(localEntry.record) &&
              localEntry.record.expiresAtMs > Date.now()))
        ) {
          this.settleLocalStorageFailure(recordId);
        }
        throw error;
      }

      if (this.pending.get(recordId) !== localEntry) {
        return result;
      }
      if (
        result.outcome === "resolved" &&
        standingGrant?.kind === "placement" &&
        localEntry &&
        this.isRuntimeAuthorityActive(localEntry.record)
      ) {
        this.options.retainPlacementStandingGrant?.({
          ...standingGrant,
          approvalId: recordId,
          nowMs: result.record.resolvedAtMs ?? Date.now(),
        });
      }
      if (
        result.outcome === "resolved" ||
        result.outcome === "expired" ||
        result.outcome === "already-resolved"
      ) {
        // The caller's source only applies when its own CAS won; a lost race or
        // expiry settles with the durable winner, which is an operator decision.
        this.settleLocalFromStore(
          result.record,
          undefined,
          localResolvedBy,
          result.outcome === "resolved" ? localResolutionSource : "operator",
        );
      } else if (result.outcome === "not-found" || result.outcome === "corrupt") {
        this.settleLocalStorageFailure(recordId);
      }
      return "record" in result && localEntry
        ? { ...result, liveRecord: localEntry.record }
        : result;
    }, recordId);
  }

  /** Persist a fail-closed terminal state, then release the local waiter. */
  async forceDenyDetailed(
    recordId: string,
    reason: OperatorApprovalTerminalReason,
    resolver: OperatorApprovalResolver,
    status: "denied" | "expired" | "cancelled" = "denied",
    localDecision?: ExecApprovalDecision | null,
    requireDue = false,
    localResolvedBy: string | null = null,
    assertResolverCurrent?: () => void,
  ): Promise<ExecApprovalForceDenyResult<TPayload>> {
    if (this.retired) {
      return { outcome: "not-found" };
    }
    const capturedRecord = this.pending.get(recordId)?.record;
    // Cancellation closes executable authority before its durable CAS can yield.
    if (!this.retired && status === "cancelled" && capturedRecord) {
      capturedRecord.approvalAuthority = () => false;
    }
    return this.trackMutation(async () => {
      if (this.retired) {
        return { outcome: "not-found" };
      }
      const persistence = this.options.persistence;
      const localRecord = this.pending.get(recordId)?.record;
      if (localRecord?.terminalReason === "storage-corrupt") {
        return this.persistStorageCorruptDeny(recordId);
      }

      let result: ForceDenyOperatorApprovalResult;
      try {
        result = await forceDenyOperatorApproval({
          id: recordId,
          status,
          requireDue,
          reason,
          resolver,
          expectedKind: this.approvalKind,
          runtimeEpoch: persistence.runtimeEpoch,
          databaseOptions: persistence.databaseOptions,
          assertCurrent: () => {
            this.assertNotRetired();
            try {
              assertResolverCurrent?.();
            } catch (error) {
              throw new ApprovalMutationRefusedError(
                "approval resolver authority is no longer active",
                { cause: error },
              );
            }
            if (this.pending.get(recordId)?.record !== localRecord) {
              throw new Error("approval binding changed before cancellation");
            }
          },
        });
      } catch (error) {
        if (
          !(error instanceof ApprovalMutationRefusedError) &&
          !this.retired &&
          this.pending.get(recordId)?.record === localRecord
        ) {
          this.settleLocalStorageFailure(recordId);
        }
        throw error;
      }
      if (this.pending.get(recordId)?.record !== localRecord) {
        return result;
      }
      if (result.outcome === "denied") {
        this.settleLocalFromStore(result.record, localDecision, localResolvedBy);
      } else if (result.outcome === "expired" || result.outcome === "already-terminal") {
        this.settleLocalFromStore(result.record, undefined, localResolvedBy);
      } else if (result.outcome === "not-found" || result.outcome === "corrupt") {
        this.settleLocalStorageFailure(recordId);
      }
      return "record" in result && localRecord ? { ...result, liveRecord: localRecord } : result;
    }, recordId);
  }

  private settleLocalFromStore(
    record: OperatorApprovalRecord,
    localDecision?: ExecApprovalDecision | null,
    localResolvedBy: string | null = null,
    localResolutionSource: ExecApprovalResolutionSource = "operator",
  ): boolean {
    const persistence = this.options.persistence;
    const liveRecord = this.pending.get(record.id)?.record;
    if (
      record.kind !== this.approvalKind ||
      record.runtimeEpoch !== persistence.runtimeEpoch ||
      record.status === "pending" ||
      record.resolvedAtMs === null
    ) {
      return false;
    }
    const settled = this.settleLocalEntry(
      prepareExecApprovalSettlement({
        record,
        resolvedAtMs: record.resolvedAtMs,
        localDecision,
        localResolvedBy,
        localResolutionSource,
      }),
    );
    if (settled) {
      this.emitLifecycle({ phase: "terminal", record });
      if (record.status === "expired" && liveRecord) {
        try {
          this.options.onExpired?.(record, liveRecord);
        } catch (error) {
          this.reportError(error, { approvalId: record.id, operation: "expire" });
        }
      }
    }
    return settled;
  }

  /** Settle one durable terminal transition and report whether this manager published it. */
  async reconcileDurableTerminal(record: OperatorApprovalRecord): Promise<boolean> {
    await this.waitForMutations(record.id);
    this.settleLocalFromStore(record);
    return this.wasTerminalPublished(record);
  }

  /** Reconciles durable truth with an existing waiter without rehydrating its request. */
  async reconcileDurableLookup(
    initialLookup: ExecApprovalDurableLookup,
    localResolvedBy: string | null = null,
  ): Promise<OperatorApprovalRecord | null> {
    if (this.retired) {
      return null;
    }
    let lookup = initialLookup;
    const recordId = lookup.outcome === "found" ? lookup.record.id : lookup.id;
    if (await this.waitForMutations(recordId)) {
      const refreshed = await getOperatorApprovalDetailed({
        id: recordId,
        nowMs: Date.now(),
        databaseOptions: this.options.persistence.databaseOptions,
      });
      lookup =
        refreshed.outcome === "found"
          ? refreshed
          : {
              outcome: refreshed.outcome === "corrupt" ? "corrupt" : "missing",
              id: recordId,
            };
    }
    if (this.retired) {
      return null;
    }
    const entry = this.pending.get(recordId);
    if (lookup.outcome !== "found") {
      if (entry) {
        this.settleLocalStorageFailure(recordId);
      }
      return null;
    }
    if (
      !entry ||
      lookup.record.kind !== this.approvalKind ||
      lookup.record.runtimeEpoch !== this.options.persistence.runtimeEpoch
    ) {
      return lookup.record;
    }
    if (lookup.record.status === "pending" && entry.record.terminalReason === "storage-corrupt") {
      const repaired = await this.trackMutation(
        () => this.persistStorageCorruptDeny(recordId),
        recordId,
      );
      return "record" in repaired ? repaired.record : null;
    }
    if (lookup.record.status !== "pending") {
      this.settleLocalFromStore(lookup.record, undefined, localResolvedBy);
    }
    return lookup.record;
  }

  private settleLocalStorageFailure(recordId: string): void {
    this.settleLocalEntry(prepareExecApprovalStorageFailure(recordId, Date.now()));
  }

  private async persistStorageCorruptDeny(
    recordId: string,
  ): Promise<ExecApprovalForceDenyResult<TPayload>> {
    const localEntry = this.pending.get(recordId);
    if (!localEntry) {
      return { outcome: "not-found" };
    }
    const result = await forceDenyOperatorApproval({
      id: recordId,
      status: "denied",
      reason: "storage-corrupt",
      resolver: { kind: "system", id: "storage-error" },
      expectedKind: this.approvalKind,
      runtimeEpoch: this.runtimeEpoch,
      databaseOptions: this.options.persistence.databaseOptions,
      assertCurrent: () => {
        this.assertNotRetired();
        if (this.pending.get(recordId) !== localEntry) {
          throw new Error("approval binding changed before repair");
        }
      },
    });
    if (result.outcome === "denied" || result.outcome === "expired") {
      this.emitLifecycle({ phase: "terminal", record: result.record });
    }
    return "record" in result ? { ...result, liveRecord: localEntry.record } : result;
  }

  protected override reportError(
    error: unknown,
    context: { approvalId: string; operation: "expire" },
  ): void {
    const onError = this.options.onError;
    if (!onError) {
      return;
    }
    try {
      onError(error instanceof Error ? error : new Error(String(error)), {
        ...context,
        approvalKind: this.approvalKind,
      });
    } catch {
      // Error reporting must not turn a fail-closed timeout into an uncaught timer exception.
    }
  }

  protected override async expireDue(recordId: string): Promise<boolean> {
    if (this.retired) {
      return false;
    }
    const entry = this.pending.get(recordId);
    if (!entry || entry.record.resolvedAtMs !== undefined) {
      return false;
    }
    const result = await this.forceDenyDetailed(
      recordId,
      "timeout",
      { kind: "system", id: null },
      "expired",
      undefined,
      true,
    );
    if (result.outcome === "not-due") {
      this.scheduleExpiryTimer(entry);
      return false;
    }
    return result.outcome === "denied" || result.outcome === "expired";
  }

  async resolve(
    recordId: string,
    decision: ExecApprovalDecision,
    resolvedBy?: string | null,
    options: { grantExpiresAtMs?: number | null; assertCurrent?: () => void } = {},
  ): Promise<boolean> {
    const result = await this.resolveDetailed(
      recordId,
      decision,
      { kind: "runtime", id: resolvedBy ?? null },
      resolvedBy ?? null,
      "operator",
      options,
    );
    return result.outcome === "resolved";
  }

  /**
   * Trusted auto-review resolution (identity-matched approval runtime).
   * Always allow-once; system.run replay validation treats the resulting
   * record more strictly than an operator decision (see #103515).
   */
  async resolveAutoReview(
    recordId: string,
    resolvedBy?: string | null,
    assertCurrent?: () => void,
  ): Promise<boolean> {
    const result = await this.resolveDetailed(
      recordId,
      "allow-once",
      { kind: "runtime", id: resolvedBy ?? null },
      resolvedBy ?? null,
      "auto-review",
      { assertCurrent },
    );
    return result.outcome === "resolved";
  }

  async expire(recordId: string, resolvedBy?: string | null): Promise<boolean> {
    const noRoute = resolvedBy === "no-approval-route";
    const result = await this.forceDenyDetailed(
      recordId,
      noRoute ? "no-route" : "timeout",
      { kind: "system", id: resolvedBy ?? null },
      noRoute ? "denied" : "expired",
      noRoute ? null : undefined,
      false,
      resolvedBy ?? null,
    );
    return result.outcome === "denied";
  }

  async consumeAllowOnce(recordId: string, consumerId = recordId): Promise<boolean> {
    // Retirement preserves consumption only inside an already-owned genuine handoff.
    const entry = this.pending.get(recordId);
    if (!this.canUseRetainedBinding() || !entry) {
      return false;
    }
    if (!this.isRuntimeAuthorityActive(entry.record)) {
      await this.forceDenyIfRuntimeAuthorityClosed(recordId);
      return false;
    }
    return this.trackMutation(async () => {
      const nowMs = Date.now();
      const graceAnchorMs = this.resolvedGraceAnchorMs(entry, nowMs);
      // Durable records are audit/control-plane truth, not executable capability
      // material. Redemption requires the live waiter entry and its requester binding.
      const redemptionWindowMs = prepareExecApprovalRedemptionWindow(
        entry.record,
        graceAnchorMs,
        nowMs,
      );
      if (redemptionWindowMs === null) {
        return false;
      }
      const persistence = this.options.persistence;
      const result = await consumeOperatorApprovalAllowOnce({
        id: recordId,
        nowMs,
        consumerId,
        expectedKind: this.approvalKind,
        runtimeEpoch: persistence.runtimeEpoch,
        redemptionWindowMs,
        databaseOptions: persistence.databaseOptions,
        assertCurrent: () => {
          const currentNowMs = Date.now();
          const currentGraceAnchorMs = this.resolvedGraceAnchorMs(entry, currentNowMs);
          if (
            !this.canUseRetainedBinding() ||
            this.pending.get(recordId) !== entry ||
            !this.isRuntimeAuthorityActive(entry.record) ||
            currentGraceAnchorMs === null ||
            currentNowMs - currentGraceAnchorMs >= EXEC_APPROVAL_RESOLVED_ENTRY_GRACE_MS
          ) {
            throw new ApprovalMutationRefusedError("approval authority is no longer active");
          }
        },
      }).catch((error: unknown) => {
        if (error instanceof ApprovalMutationRefusedError) {
          return null;
        }
        throw error;
      });
      if (!result || result.outcome !== "consumed" || this.pending.get(recordId) !== entry) {
        return false;
      }
      // Keep the winning decision for audit/retry reporting; consumedDecision
      // is the process-local replay guard during the resolved grace window.
      entry.record.consumedDecision = "allow-once";
      entry.record.consumedAtMs = result.record.consumedAtMs;
      entry.record.consumedBy = result.record.consumedBy;
      return this.isRuntimeAuthorityActive(entry.record);
    }, recordId);
  }

  /** Observes a registered decision; Gateway closure rejects the wait, not the approval. */
  awaitDecision(recordId: string): Promise<ExecApprovalDecision | null> | null {
    this.assertNotRetired();
    this.scheduleAuthorityClosure(recordId);
    const snapshot = this.getLocalSnapshot(recordId);
    if (!snapshot) {
      return null;
    }
    if (snapshot.resolvedAtMs === undefined && snapshot.expiresAtMs <= Date.now()) {
      void this.expireDue(recordId).catch((error: unknown) => {
        this.reportError(error, { approvalId: recordId, operation: "expire" });
      });
    }
    const entry = this.pending.get(recordId);
    return entry ? this.observeEntry(entry, entry.promise) : null;
  }

  /** Projects an allowed decision only while its exact runtime authority is live. */
  projectDecisionIfActive(
    recordId: string,
    decision: ExecApprovalDecision | null,
  ): ExecApprovalDecision | null {
    if (decision !== "allow-once" && decision !== "allow-always") {
      return decision;
    }
    const record = this.pending.get(recordId)?.record;
    if (!this.canUseRetainedBinding() || !record) {
      // Durable approval truth is not executable authority. Once the local
      // binding is gone, stale handoffs must fail closed even if they kept its verdict.
      return null;
    }
    if (this.isRuntimeAuthorityActive(record)) {
      return decision;
    }
    // Durable first-answer truth remains auditable even when closure races an
    // already-allowed row. Executable projection fails closed at this handoff.
    this.scheduleAuthorityClosure(recordId);
    return null;
  }

  /** Atomically closes a live approval whose exact runtime owner is gone. */
  async forceDenyIfRuntimeAuthorityClosed(
    recordId: string,
  ): Promise<ExecApprovalForceDenyResult<TPayload> | null> {
    const record = this.pending.get(recordId)?.record;
    if (!record || this.isRuntimeAuthorityActive(record)) {
      return null;
    }
    return this.forceDenyDetailed(
      recordId,
      "run-aborted",
      { kind: "system", id: null },
      "cancelled",
    );
  }
}
