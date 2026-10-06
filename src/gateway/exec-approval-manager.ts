import type { ExecApprovalDecision, ExecApprovalRequestPayload } from "../infra/exec-approvals.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import {
  ApprovalMutationRefusedError,
  createExecApprovalMutationGuard,
  isExecApprovalRuntimeActive,
  isExecApprovalMutationRefused,
} from "./exec-approval-authority.js";
import { ExecApprovalExpiry } from "./exec-approval-expiry.js";
import {
  EXEC_APPROVAL_RESOLVED_ENTRY_GRACE_MS,
  prepareExecApprovalRedemptionWindow,
} from "./exec-approval-lifecycle.js";
import type {
  ExecApprovalDurableLookup,
  ExecApprovalForceDenyResult,
  ExecApprovalManagerOptions,
  ExecApprovalRecord,
  ExecApprovalReadAuthority,
  ExecApprovalResolutionSource,
  ExecApprovalResolveResult,
  ExecApprovalResolveOptions,
} from "./exec-approval-manager.types.js";
import {
  assertExecApprovalMutationPersistenceCurrent,
  assertUncertainExecApprovalPersistenceCurrent,
  captureExecApprovalMutationPersistence,
  readUncertainExecApprovalVerdict,
  runWithExecApprovalMutationPersistence,
  type ExecApprovalMutationPersistence,
} from "./exec-approval-recovery.js";
import {
  createExecApprovalRecord,
  prepareExecApprovalPresentation,
  prepareExecApprovalRegistration,
} from "./exec-approval-registration.js";
import {
  prepareExecApprovalStandingGrant,
  projectClosedApprovalResolution,
  projectRepairedApprovalResolution,
} from "./exec-approval-results.js";
import {
  consumeOperatorApprovalAllowOnce,
  forceDenyOperatorApproval,
  getOperatorApprovalDetailed,
  insertOperatorApproval,
  isOperatorApprovalStoreOutcomeUnknown,
  resolveOperatorApproval,
  type ForceDenyOperatorApprovalResult,
  type OperatorApprovalKind,
  type OperatorApprovalRecord,
  type OperatorApprovalResolver,
  type OperatorApprovalTerminalReason,
  type ResolveOperatorApprovalResult,
} from "./operator-approval-store.js";
import type { OperatorApprovalStoreGuard } from "./operator-approval-store.types.js";

export { EXEC_APPROVAL_RESOLVED_ENTRY_GRACE_MS } from "./exec-approval-lifecycle.js";
export type {
  ExecApprovalIdLookupResult,
  ExecApprovalRecord,
  OperatorApprovalLifecycleEvent,
  OperatorStandingGrantMintSpec,
} from "./exec-approval-manager.types.js";

/** Approval creation and persistence precede every local wait or delivery handoff. */
export class ExecApprovalManager<
  TPayload = ExecApprovalRequestPayload,
> extends ExecApprovalExpiry<TPayload> {
  constructor(protected readonly options: ExecApprovalManagerOptions<TPayload>) {
    super(options.scheduler);
  }

  override get approvalKind(): OperatorApprovalKind {
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
        if (!isExecApprovalRuntimeActive(this.options, record)) {
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
      if (!isExecApprovalRuntimeActive(this.options, record)) {
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

  /** Persist the first verdict, then release the process-local waiter. */
  async resolveDetailed(
    recordId: string,
    decision: ExecApprovalDecision,
    resolver: OperatorApprovalResolver,
    localResolvedBy: string | null = null,
    localResolutionSource: ExecApprovalResolutionSource = "operator",
    options: ExecApprovalResolveOptions = {},
  ): Promise<ExecApprovalResolveResult<TPayload>> {
    if (this.retired) {
      return { outcome: "not-found" };
    }
    options.guard?.assertCurrent();
    options.assertCurrent?.();
    const capturedEntry = this.pending.get(recordId);
    const retainedPersistence = capturedEntry?.expiryPersistence;
    this.assertPendingPersistenceCurrent(capturedEntry);
    if (
      decision !== "deny" &&
      capturedEntry &&
      !isExecApprovalRuntimeActive(this.options, capturedEntry.record)
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
      let persistence: ExecApprovalMutationPersistence = this.options.persistence;
      if (localEntry?.record.terminalReason === "storage-corrupt") {
        const repaired = await this.persistStorageCorruptDeny(
          recordId,
          options.assertCurrent,
          options.guard,
        );
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
      let committedResolutionKey: string | undefined;
      try {
        persistence = retainedPersistence ?? captureExecApprovalMutationPersistence(persistence);
        const guard = createExecApprovalMutationGuard(
          () => this.assertNotRetired(),
          () => {
            if (retainedPersistence) {
              assertExecApprovalMutationPersistenceCurrent(retainedPersistence);
            }
            this.assertPendingPersistenceCurrent(localEntry);
            if (
              this.pending.get(recordId) !== localEntry ||
              (localEntry &&
                localEntry.record.expiresAtMs > nowMs &&
                localEntry.record.expiresAtMs <= Date.now()) ||
              (decision !== "deny" &&
                (!localEntry || !isExecApprovalRuntimeActive(this.options, localEntry.record)))
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
          options,
        );
        if (retainedPersistence) {
          guard.assertCurrent();
        }
        result = await runWithExecApprovalMutationPersistence(persistence, () =>
          resolveOperatorApproval({
            id: recordId,
            nowMs,
            decision,
            resolver,
            expectedKind: this.approvalKind,
            runtimeEpoch: persistence.runtimeEpoch,
            databaseOptions: persistence.databaseOptions,
            onCommitted: (key) => {
              committedResolutionKey = key;
            },
            guard,
            ...(standingGrant?.kind === "cron" ? { standingGrant } : {}),
            ...(standingGrant?.kind === "mcp-tool" ? { mcpToolGrant: standingGrant } : {}),
          }),
        );
      } catch (error) {
        const uncertain = await this.recoverUnknownVerdict(
          error,
          localEntry?.record,
          persistence,
          localResolutionSource,
          committedResolutionKey,
        );
        if (
          !uncertain &&
          !isExecApprovalMutationRefused(error) &&
          !this.retired &&
          this.pending.get(recordId) === localEntry &&
          (!localEntry ||
            (isExecApprovalRuntimeActive(this.options, localEntry.record) &&
              localEntry.record.expiresAtMs > Date.now()))
        ) {
          this.settleLocalStorageFailure(recordId);
        }
        throw error;
      }

      if (this.pending.get(recordId) !== localEntry) {
        return result;
      }
      this.assertPendingPersistenceCurrent(localEntry);
      if (
        result.outcome === "resolved" &&
        standingGrant?.kind === "placement" &&
        localEntry &&
        isExecApprovalRuntimeActive(this.options, localEntry.record)
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
        // A confirmed CAS supplies its source; observations retain any stricter
        // provenance from an earlier uncertain auto-review outcome.
        this.settleLocalFromStore(
          result.record,
          undefined,
          localResolvedBy,
          result.outcome === "resolved" ? localResolutionSource : undefined,
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
    callerGuard?: OperatorApprovalStoreGuard,
  ): Promise<ExecApprovalForceDenyResult<TPayload>> {
    if (this.retired) {
      return { outcome: "not-found" };
    }
    callerGuard?.assertCurrent();
    assertResolverCurrent?.();
    const capturedEntry = this.pending.get(recordId);
    const retainedPersistence = capturedEntry?.expiryPersistence;
    const capturedRecord = capturedEntry?.record;
    // Cancellation closes executable authority before its durable CAS can yield.
    if (!this.retired && status === "cancelled" && capturedRecord) {
      capturedRecord.approvalAuthority = () => false;
    }
    this.assertPendingPersistenceCurrent(capturedEntry);
    return this.trackMutation(async () => {
      if (this.retired) {
        return { outcome: "not-found" };
      }
      let persistence: ExecApprovalMutationPersistence = this.options.persistence;
      const localRecord = capturedRecord;
      if (localRecord?.terminalReason === "storage-corrupt") {
        return this.persistStorageCorruptDeny(recordId, assertResolverCurrent, callerGuard);
      }

      let result: ForceDenyOperatorApprovalResult;
      try {
        persistence = retainedPersistence ?? captureExecApprovalMutationPersistence(persistence);
        const guard = createExecApprovalMutationGuard(
          () => this.assertNotRetired(),
          () => {
            if (retainedPersistence) {
              assertExecApprovalMutationPersistenceCurrent(retainedPersistence);
            }
            this.assertPendingPersistenceCurrent(capturedEntry);
            if (this.pending.get(recordId) !== capturedEntry) {
              throw new Error("approval binding changed before cancellation");
            }
          },
          { guard: callerGuard, assertCurrent: assertResolverCurrent },
        );
        if (retainedPersistence) {
          guard.assertCurrent();
        }
        const deny = () =>
          forceDenyOperatorApproval({
            id: recordId,
            status,
            requireDue,
            reason,
            resolver,
            expectedKind: this.approvalKind,
            runtimeEpoch: persistence.runtimeEpoch,
            databaseOptions: persistence.databaseOptions,
            guard,
          });
        result = await runWithExecApprovalMutationPersistence(persistence, deny);
      } catch (error) {
        const uncertain = await this.recoverUnknownVerdict(error, localRecord, persistence);
        if (
          !uncertain &&
          !isExecApprovalMutationRefused(error) &&
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
      this.assertPendingPersistenceCurrent(capturedEntry);
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

  private async recoverUnknownVerdict(
    error: unknown,
    localRecord: ExecApprovalRecord<TPayload> | undefined,
    persistence: ExecApprovalMutationPersistence,
    source: ExecApprovalResolutionSource = "operator",
    committedResolutionKey?: string,
  ): Promise<boolean> {
    if (isOperatorApprovalStoreOutcomeUnknown(error)) {
      this.retainUncertainVerdict(localRecord, {
        assertCurrent: () => assertExecApprovalMutationPersistenceCurrent(persistence),
        ...(source === "auto-review" ? { autoReview: { committedResolutionKey } } : {}),
      });
    }
    const record = await readUncertainExecApprovalVerdict(
      error,
      localRecord && this.pending.get(localRecord.id)?.record === localRecord
        ? localRecord
        : undefined,
      this.approvalKind,
      persistence,
    );
    if (record && this.pending.get(record.id)?.record === localRecord) {
      assertUncertainExecApprovalPersistenceCurrent(error, persistence);
      if (record.status === "pending" && localRecord) {
        this.clearUncommittedVerdict(localRecord);
      } else {
        this.settleLocalFromStore(record, undefined, record.resolver?.id ?? null);
      }
    }
    return record !== undefined;
  }

  /** Reconciles durable truth with an existing waiter without rehydrating its request. */
  async reconcileDurableLookup(
    initialLookup: ExecApprovalDurableLookup,
    localResolvedBy: string | null = null,
    authority?: ExecApprovalReadAuthority,
  ): Promise<OperatorApprovalRecord | null> {
    if (this.retired) {
      return null;
    }
    let lookup = initialLookup;
    const recordId = lookup.outcome === "found" ? lookup.record.id : lookup.id;
    authority?.assertCurrent();
    const waited = await this.waitForMutations(recordId);
    authority?.assertCurrent();
    if (waited) {
      const refreshed = await getOperatorApprovalDetailed({
        id: recordId,
        nowMs: Date.now(),
        databaseOptions: this.options.persistence.databaseOptions,
        guard: authority?.guard,
      });
      authority?.assertCurrent();
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
      const repaired = await this.trackMutation(() => {
        authority?.assertCurrent();
        return this.persistStorageCorruptDeny(recordId, undefined, authority?.guard);
      }, recordId);
      return "record" in repaired ? repaired.record : null;
    }
    if (lookup.record.status !== "pending") {
      this.settleLocalFromStore(lookup.record, undefined, localResolvedBy);
    }
    return lookup.record;
  }

  private async persistStorageCorruptDeny(
    recordId: string,
    assertCurrent?: () => void,
    callerGuard?: OperatorApprovalStoreGuard,
  ): Promise<ExecApprovalForceDenyResult<TPayload>> {
    callerGuard?.assertCurrent();
    assertCurrent?.();
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
      guard: createExecApprovalMutationGuard(
        () => this.assertNotRetired(),
        () => {
          if (this.pending.get(recordId) !== localEntry) {
            throw new Error("approval binding changed before repair");
          }
        },
        { guard: callerGuard, assertCurrent },
      ),
    });
    if (result.outcome === "denied" || result.outcome === "expired") {
      this.emitLifecycle({ phase: "terminal", record: result.record });
    }
    return "record" in result ? { ...result, liveRecord: localEntry.record } : result;
  }

  async resolve(
    recordId: string,
    decision: ExecApprovalDecision,
    resolvedBy?: string | null,
    options: ExecApprovalResolveOptions = {},
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
    guard?: OperatorApprovalStoreGuard,
  ): Promise<boolean> {
    const result = await this.resolveDetailed(
      recordId,
      "allow-once",
      { kind: "runtime", id: resolvedBy ?? null },
      resolvedBy ?? null,
      "auto-review",
      { assertCurrent, guard },
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
    if (!isExecApprovalRuntimeActive(this.options, entry.record)) {
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
            !isExecApprovalRuntimeActive(this.options, entry.record) ||
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
      return isExecApprovalRuntimeActive(this.options, entry.record);
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
    if (isExecApprovalRuntimeActive(this.options, record)) {
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
    if (!record || isExecApprovalRuntimeActive(this.options, record)) {
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
