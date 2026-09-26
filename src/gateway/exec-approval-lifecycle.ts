import { expectDefined } from "@openclaw/normalization-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { ExecApprovalDecision } from "../infra/exec-approvals.js";
import type { GatewayScheduledJob, GatewayScheduler } from "../infra/gateway-scheduler.js";
import {
  captureGatewayRootWorkAdmissionContinuationScope,
  runWithRetainedGatewayRootWork,
  type GatewayRootWorkAdmissionContinuationScope,
} from "../process/gateway-work-admission.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import type {
  ExecApprovalIdLookupResult,
  ExecApprovalManagerOptions,
  ExecApprovalRecord,
  ExecApprovalReadAuthority,
  ExecApprovalResolutionSource,
  OperatorApprovalLifecycleEvent,
} from "./exec-approval-manager.types.js";
import {
  assertExecApprovalMutationPersistenceCurrent,
  type ExecApprovalMutationPersistence,
} from "./exec-approval-recovery.js";
import {
  prepareExecApprovalSettlement,
  prepareExecApprovalStorageFailure,
} from "./exec-approval-results.js";
import type {
  OperatorApprovalRecord,
  OperatorApprovalKind,
  OperatorApprovalResolver,
  OperatorApprovalStatus,
  OperatorApprovalTerminalReason,
} from "./operator-approval-store.js";
import { getOperatorApprovalResolutionKey } from "./operator-approval-store.rows.js";

// Node ask-fallback replay uses the same grace anchor as manager binding retention.
export const EXEC_APPROVAL_RESOLVED_ENTRY_GRACE_MS = 15_000;

/** Observer retirement is not an approval verdict or a durable expiry. */
export class ApprovalObserverClosedError extends Error {
  constructor() {
    super("Gateway approval observer closed");
    this.name = "ApprovalObserverClosedError";
  }
}

type DecisionHandoff = {
  start: (decision: ExecApprovalDecision | null) => void;
  cancel: () => void;
};

export type PendingEntry<TPayload> = {
  record: ExecApprovalRecord<TPayload>;
  resolve: (decision: ExecApprovalDecision | null) => void;
  expiryJob: GatewayScheduledJob | null;
  cleanupJob: GatewayScheduledJob | null;
  handoffRetainCount: number;
  handoffReleasedAtMs: number | null;
  retainForManagerLifetime: boolean;
  promise: Promise<ExecApprovalDecision | null>;
  handoffs: Set<DecisionHandoff>;
  admissionContinuation: GatewayRootWorkAdmissionContinuationScope | null;
  mutation?: Promise<void>;
  expiryPersistence?: ExecApprovalMutationPersistence;
  expiryRefusals?: number;
  uncertainVerdict?: {
    assertCurrent: () => void;
    autoReview?: { committedResolutionKey?: string };
  };
  terminalPublication?: Pick<
    OperatorApprovalRecord,
    | "kind"
    | "runtimeEpoch"
    | "status"
    | "decision"
    | "terminalReason"
    | "resolvedAtMs"
    | "updatedAtMs"
  >;
};

/** Owns local observations and genuine decision effects, never durable decision policy. */
export abstract class ExecApprovalLifecycle<TPayload> {
  protected readonly pending = new Map<string, PendingEntry<TPayload>>();
  protected retired = false;
  private observingClosed = false;
  private readonly observers = new Set<() => void>();
  private readonly work = new AsyncWorkScope();
  private draining: Promise<void> | undefined;

  constructor(protected readonly scheduler: GatewayScheduler) {}

  abstract get runtimeEpoch(): string;
  protected abstract expireDue(
    recordId: string,
    authority?: ExecApprovalReadAuthority,
  ): Promise<boolean>;
  abstract get approvalKind(): OperatorApprovalKind;
  protected abstract readonly options: Pick<
    ExecApprovalManagerOptions<TPayload>,
    "onError" | "onExpired" | "onLifecycle"
  >;

  protected emitLifecycle(event: OperatorApprovalLifecycleEvent): void {
    try {
      this.recordLifecyclePublication(event, this.options.onLifecycle !== undefined);
      this.options.onLifecycle?.(event);
    } catch {
      // Stream fanout is observational. It must never change approval truth or
      // prevent the durable first-answer transition from releasing its waiter.
    }
  }

  protected retainUncertainVerdict(
    record: ExecApprovalRecord<TPayload> | undefined,
    uncertainty: NonNullable<PendingEntry<TPayload>["uncertainVerdict"]>,
  ): void {
    const entry = record ? this.pending.get(record.id) : undefined;
    if (entry && entry.record === record && record.resolvedAtMs === undefined) {
      // Retries retain the original owner and cannot erase possible auto-review provenance.
      entry.uncertainVerdict ??= uncertainty;
      if (uncertainty.autoReview && !entry.uncertainVerdict.autoReview?.committedResolutionKey) {
        entry.uncertainVerdict.autoReview = uncertainty.autoReview;
      }
    }
  }

  protected assertPendingPersistenceCurrent(entry: PendingEntry<TPayload> | undefined): void {
    entry?.uncertainVerdict?.assertCurrent();
    if (entry?.expiryPersistence) {
      assertExecApprovalMutationPersistenceCurrent(entry.expiryPersistence);
    }
  }

  protected clearUncommittedVerdict(record: ExecApprovalRecord<TPayload>): void {
    const entry = this.pending.get(record.id);
    if (entry?.record === record && !entry.uncertainVerdict?.autoReview?.committedResolutionKey) {
      this.assertPendingPersistenceCurrent(entry);
      delete entry.uncertainVerdict;
    }
  }

  protected settleLocalStorageFailure(recordId: string): void {
    this.settleLocalEntry(prepareExecApprovalStorageFailure(recordId, Date.now()));
  }

  protected settleLocalFromStore(
    record: OperatorApprovalRecord,
    localDecision?: ExecApprovalDecision | null,
    localResolvedBy: string | null = null,
    localResolutionSource?: ExecApprovalResolutionSource,
  ): boolean {
    const entry = this.pending.get(record.id);
    const liveRecord = entry?.record;
    const uncertainty = entry?.uncertainVerdict;
    let observedSource: ExecApprovalResolutionSource = "operator";
    if (localResolutionSource === undefined && uncertainty) {
      if (
        uncertainty.autoReview &&
        record.status === "allowed" &&
        record.decision === "allow-once"
      ) {
        if (
          uncertainty.autoReview.committedResolutionKey === getOperatorApprovalResolutionKey(record)
        ) {
          observedSource = "auto-review";
        } else if (record.resolver?.kind === "runtime") {
          // Runtime IDs are shared by operator and auto-review callers, including null IDs.
          return false;
        }
      }
    }
    const settlement = prepareExecApprovalSettlement({
      record,
      expectedKind: this.approvalKind,
      runtimeEpoch: this.runtimeEpoch,
      localDecision,
      localResolvedBy,
      localResolutionSource: localResolutionSource ?? observedSource,
    });
    if (!settlement) {
      return false;
    }
    const settled = this.settleLocalEntry(settlement);
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

  protected reportError(
    error: unknown,
    context: { approvalId: string; operation: "expire" },
  ): void {
    try {
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)), {
        ...context,
        approvalKind: this.approvalKind,
      });
    } catch {
      // Reporting is observational; the lifecycle owner keeps the original outcome.
    }
  }

  beginClose(): void {
    this.observingClosed = true;
    for (const close of this.observers) {
      close();
    }
  }

  retire(): void {
    if (this.retired) {
      return;
    }
    this.retired = true;
    this.beginClose();
    for (const [id, entry] of this.pending) {
      entry.expiryJob?.cancel();
      entry.cleanupJob?.cancel();
      entry.expiryJob = null;
      entry.cleanupJob = null;
      entry.admissionContinuation?.release();
      entry.admissionContinuation = null;
      if (entry.record.resolvedAtMs === undefined && !this.work.hasPendingWork) {
        for (const handoff of entry.handoffs) {
          handoff.cancel();
        }
      }
      // Recorded handoffs still need their binding for projection and allow-once consumption.
      // Unanswered authority promises are discarded locally, never resolved as a decision.
      if (entry.handoffRetainCount === 0 && !this.work.hasPendingWork) {
        this.pending.delete(id);
      }
    }
  }

  drain(): Promise<void> {
    this.retire();
    this.draining ??= this.work.drain().then(() => {
      for (const entry of this.pending.values()) {
        for (const handoff of entry.handoffs) {
          handoff.cancel();
        }
      }
      this.pending.clear();
    });
    return this.draining;
  }

  trackActiveWork<T>(run: () => T | Promise<T>): Promise<T> {
    this.assertNotRetired();
    return this.work.track(() => runWithRetainedGatewayRootWork(run));
  }

  /** Accepted mutations retain their result and any committed handoff through retirement. */
  protected trackMutation<T>(run: () => Promise<T>, recordId?: string): Promise<T> {
    const entry = recordId === undefined ? undefined : this.pending.get(recordId);
    const previous = entry?.mutation;
    const result = this.work.track(() =>
      runWithRetainedGatewayRootWork(() => (previous ? previous.then(run) : run())),
    );
    if (entry) {
      const settled = result.then(
        () => undefined,
        () => undefined,
      );
      entry.mutation = settled;
      void settled.then(() => {
        if (entry.mutation === settled) {
          entry.mutation = undefined;
        }
      });
    }
    return result;
  }

  /** Native readers cannot publish ahead of the accepted winner's process-local provenance. */
  protected async waitForMutations(recordId: string): Promise<boolean> {
    let waited = false;
    for (
      let mutation = this.pending.get(recordId)?.mutation;
      mutation;
      mutation = this.pending.get(recordId)?.mutation
    ) {
      waited = true;
      await mutation;
    }
    return waited;
  }

  /** Keep publication identity with the waiter, including durable storage-repair outcomes. */
  protected recordLifecyclePublication(
    event: OperatorApprovalLifecycleEvent,
    hasPublisher: boolean,
  ): void {
    const entry = this.pending.get(event.record.id);
    if (!hasPublisher || event.phase !== "terminal" || !entry) {
      return;
    }
    const record = event.record;
    entry.terminalPublication = {
      kind: record.kind,
      runtimeEpoch: record.runtimeEpoch,
      status: record.status,
      decision: record.decision,
      terminalReason: record.terminalReason,
      resolvedAtMs: record.resolvedAtMs,
      updatedAtMs: record.updatedAtMs,
    };
  }

  protected wasTerminalPublished(record: OperatorApprovalRecord): boolean {
    const published = this.pending.get(record.id)?.terminalPublication;
    return (
      published !== undefined &&
      published.kind === record.kind &&
      published.runtimeEpoch === record.runtimeEpoch &&
      published.status === record.status &&
      published.decision === record.decision &&
      published.terminalReason === record.terminalReason &&
      published.resolvedAtMs === record.resolvedAtMs &&
      published.updatedAtMs === record.updatedAtMs
    );
  }

  protected canUseRetainedBinding(): boolean {
    return !this.retired || getAsyncWorkSignal() === this.work.signal;
  }

  protected assertNotRetired(): void {
    if (this.retired) {
      throw new ApprovalObserverClosedError();
    }
  }

  protected registerEntry(
    record: ExecApprovalRecord<TPayload>,
  ): Promise<ExecApprovalDecision | null> {
    const decision = createDeferredCore<ExecApprovalDecision | null>();
    const entry: PendingEntry<TPayload> = {
      record,
      resolve: decision.resolve,
      expiryJob: null,
      cleanupJob: null,
      handoffRetainCount: 0,
      handoffReleasedAtMs: null,
      retainForManagerLifetime: false,
      promise: decision.promise,
      handoffs: new Set(),
      admissionContinuation: captureGatewayRootWorkAdmissionContinuationScope(),
    };
    this.pending.set(record.id, entry);
    this.scheduleExpiry(entry);
    return decision.promise;
  }

  /** Registers the real effect before an observer can leave or a synchronous verdict can win. */
  registerDecisionHandoff(
    recordId: string,
    run: (decision: ExecApprovalDecision | null) => Promise<void>,
  ): { observation: Promise<void>; abandon: () => void } {
    this.assertNotRetired();
    const entry = expectDefined(this.pending.get(recordId), "registered approval handoff");
    const releaseBinding = expectDefined(this.retainForHandoff(recordId), "live approval handoff");
    const completion = createDeferredCore();
    const handoff: DecisionHandoff = {
      start: (decision) => {
        if (!entry.handoffs.delete(handoff)) {
          return;
        }
        // Pending approvals stay idle; only a real transition retains its current root.
        const active = this.work.track(() =>
          runWithRetainedGatewayRootWork(async () => {
            try {
              // Register now, but preserve the original post-settlement callback ordering.
              await Promise.resolve();
              await run(decision);
            } finally {
              releaseBinding();
            }
          }),
        );
        void active.then(completion.resolve, completion.reject);
      },
      cancel: () => {
        if (entry.handoffs.delete(handoff)) {
          releaseBinding();
          completion.reject(new ApprovalObserverClosedError());
        }
      },
    };
    entry.handoffs.add(handoff);
    if (entry.record.resolvedAtMs !== undefined) {
      handoff.start(entry.record.decision ?? entry.record.consumedDecision ?? null);
    }
    return { observation: this.observeEntry(entry, completion.promise), abandon: handoff.cancel };
  }

  protected observeEntry<T>(entry: PendingEntry<TPayload>, completion: Promise<T>): Promise<T> {
    const signal = getAsyncWorkSignal();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (settle: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        this.observers.delete(onClose);
        signal?.removeEventListener("abort", onClose);
        settle();
      };
      const onClose = () => {
        // The recorded fact wins even when close precedes its promise continuation.
        if (entry.record.resolvedAtMs === undefined) {
          finish(() => reject(new ApprovalObserverClosedError()));
        }
      };
      void completion.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => {
          const failure =
            error instanceof Error ? error : new Error(String(error), { cause: error });
          finish(() => reject(failure));
        },
      );
      this.observers.add(onClose);
      signal?.addEventListener("abort", onClose, { once: true });
      if (this.observingClosed || signal?.aborted) {
        onClose();
      }
    });
  }

  protected settleLocalEntry(params: {
    recordId: string;
    decision: ExecApprovalDecision | null;
    resolvedAtMs: number;
    resolvedBy: string | null;
    resolverKind: OperatorApprovalResolver["kind"] | null;
    status: OperatorApprovalStatus;
    terminalReason: OperatorApprovalTerminalReason | null;
    consumedAtMs?: number | null;
    consumedBy?: string | null;
    resolutionSource?: ExecApprovalResolutionSource;
    retainForManagerLifetime?: boolean;
  }): boolean {
    const pending = this.pending.get(params.recordId);
    if (!pending || pending.record.resolvedAtMs !== undefined || !this.canUseRetainedBinding()) {
      return false;
    }
    this.assertPendingPersistenceCurrent(pending);
    delete pending.uncertainVerdict;
    delete pending.expiryPersistence;
    delete pending.expiryRefusals;
    pending.expiryJob?.cancel();
    pending.expiryJob = null;
    pending.record.resolvedAtMs = params.resolvedAtMs;
    if (params.decision === null) {
      delete pending.record.decision;
    } else {
      pending.record.decision = params.decision;
      // Only explicit decisions carry a source; expiry cannot authorize auto-review replay.
      pending.record.resolutionSource = params.resolutionSource ?? "operator";
    }
    pending.record.resolvedBy = params.resolvedBy;
    pending.record.resolverKind = params.resolverKind;
    pending.record.status = params.status;
    pending.record.terminalReason = params.terminalReason;
    pending.record.runtimeEpoch = this.runtimeEpoch;
    pending.record.consumedAtMs = params.consumedAtMs ?? null;
    pending.record.consumedBy = params.consumedBy ?? null;
    delete pending.record.mcpToolApprovalActive;
    pending.retainForManagerLifetime ||= params.retainForManagerLifetime === true;
    pending.admissionContinuation?.release();
    pending.admissionContinuation = null;
    for (const handoff of pending.handoffs) {
      handoff.start(params.decision);
    }
    pending.resolve(params.decision);
    this.scheduleResolvedCleanup(pending);
    return true;
  }

  private scheduleResolvedCleanup(entry: PendingEntry<TPayload>): void {
    if (
      this.retired ||
      entry.cleanupJob ||
      entry.record.resolvedAtMs === undefined ||
      entry.retainForManagerLifetime ||
      entry.handoffRetainCount > 0
    ) {
      return;
    }
    entry.cleanupJob = this.scheduler.schedule({
      id: `approval:${this.runtimeEpoch}:${this.approvalKind}:${entry.record.id}:cleanup`,
      delayMs: EXEC_APPROVAL_RESOLVED_ENTRY_GRACE_MS,
      run: () => {
        entry.cleanupJob = null;
        if (this.pending.get(entry.record.id) === entry && entry.handoffRetainCount === 0) {
          this.pending.delete(entry.record.id);
        }
      },
    });
  }

  protected resolvedGraceAnchorMs(entry: PendingEntry<TPayload>, nowMs: number): number | null {
    if (entry.record.resolvedAtMs === undefined) {
      return null;
    }
    return entry.handoffRetainCount > 0
      ? nowMs
      : (entry.handoffReleasedAtMs ?? entry.record.resolvedAtMs);
  }

  /** Final release starts a fresh grace only while the manager still owns its lifecycle. */
  retainForHandoff(recordId: string): (() => void) | null {
    const entry = this.pending.get(recordId);
    if (!entry) {
      return null;
    }
    const nowMs = Date.now();
    const graceAnchorMs = this.resolvedGraceAnchorMs(entry, nowMs);
    if (
      !entry.retainForManagerLifetime &&
      graceAnchorMs !== null &&
      entry.handoffRetainCount === 0 &&
      nowMs - graceAnchorMs >= EXEC_APPROVAL_RESOLVED_ENTRY_GRACE_MS
    ) {
      this.pending.delete(recordId);
      return null;
    }
    entry.cleanupJob?.cancel();
    entry.cleanupJob = null;
    entry.handoffRetainCount += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      if (this.pending.get(recordId) !== entry) {
        return;
      }
      entry.handoffRetainCount = Math.max(0, entry.handoffRetainCount - 1);
      if (entry.handoffRetainCount === 0 && entry.record.resolvedAtMs !== undefined) {
        entry.handoffReleasedAtMs = Date.now();
        this.scheduleResolvedCleanup(entry);
      }
    };
  }

  protected abstract scheduleExpiry(entry: PendingEntry<TPayload>, delayMs?: number): void;

  async getSnapshot(
    recordId: string,
    authority?: ExecApprovalReadAuthority,
  ): Promise<ExecApprovalRecord<TPayload> | null> {
    authority?.assertCurrent();
    const record = this.getLocalSnapshot(recordId);
    if (
      !this.retired &&
      record &&
      record.resolvedAtMs === undefined &&
      record.expiresAtMs <= Date.now()
    ) {
      await this.expireDue(recordId, authority);
    }
    authority?.assertCurrent();
    return this.getLocalSnapshot(recordId);
  }

  /** Pure binding lookup for synchronous resource authorization; never grants a decision. */
  getLocalSnapshot(recordId: string): ExecApprovalRecord<TPayload> | null {
    const entry = this.pending.get(recordId);
    if (!entry) {
      return null;
    }
    const nowMs = Date.now();
    const graceAnchorMs = this.resolvedGraceAnchorMs(entry, nowMs);
    if (
      entry.record.terminalReason !== "storage-corrupt" &&
      graceAnchorMs !== null &&
      nowMs - graceAnchorMs >= EXEC_APPROVAL_RESOLVED_ENTRY_GRACE_MS
    ) {
      this.pending.delete(recordId);
      return null;
    }
    return entry.record;
  }

  /** Reads a live local binding without entering durable storage or mutating expiry. */
  getLiveSnapshot(recordId: string): ExecApprovalRecord<TPayload> | null {
    const entry = this.pending.get(recordId);
    if (!entry) {
      return null;
    }
    const nowMs = Date.now();
    if (entry.record.resolvedAtMs === undefined) {
      return entry.record.expiresAtMs > nowMs ? entry.record : null;
    }
    const graceAnchorMs = this.resolvedGraceAnchorMs(entry, nowMs);
    return graceAnchorMs !== null && nowMs - graceAnchorMs < EXEC_APPROVAL_RESOLVED_ENTRY_GRACE_MS
      ? entry.record
      : null;
  }

  /**
   * One-shot ask-fallback re-admission for a timed-out approval. This is
   * pre-gate policy on the process-local record only: the durable row stays
   * `expired` and no execution authority is minted here. The shipped askFallback
   * policy (docs/tools/exec-approvals.md) still applies; system.run replay
   * uses this flag to keep re-admission single-use.
   */
  consumeAskFallback(recordId: string): boolean {
    const entry = this.pending.get(recordId);
    if (!entry) {
      return false;
    }
    const record = entry.record;
    if (
      record.resolvedAtMs === undefined ||
      record.decision !== undefined ||
      record.consumedDecision !== undefined ||
      record.askFallbackConsumed === true ||
      // Only unanswered approvals (timeout or no delivery route) are
      // re-admissible. Cancelled/fenced records also end decision-less, but
      // their authority closed deliberately — never replay through them.
      (record.status !== "expired" && record.terminalReason !== "no-route")
    ) {
      return false;
    }
    record.askFallbackConsumed = true;
    return true;
  }

  /** Re-enters only the pending approval's exact original root. */
  runPendingContinuation<T>(recordId: string, run: () => Promise<T>): Promise<T> | null {
    const entry = this.pending.get(recordId);
    if (
      this.retired ||
      !entry?.admissionContinuation ||
      entry.record.resolvedAtMs !== undefined ||
      entry.record.expiresAtMs <= Date.now()
    ) {
      return null;
    }
    return entry.admissionContinuation.run(run);
  }

  async listPendingRecords(
    authority?: ExecApprovalReadAuthority,
  ): Promise<ExecApprovalRecord<TPayload>[]> {
    authority?.assertCurrent();
    if (this.retired) {
      return [];
    }
    const nowMs = Date.now();
    for (const entry of this.pending.values()) {
      if (entry.record.resolvedAtMs === undefined && entry.record.expiresAtMs <= nowMs) {
        await this.expireDue(entry.record.id, authority);
        authority?.assertCurrent();
      }
    }
    return this.listLocalPendingRecords();
  }

  /** Closure callbacks revoke these bindings synchronously before awaiting persistence. */
  listLocalPendingRecords(): ExecApprovalRecord<TPayload>[] {
    if (this.retired) {
      return [];
    }
    return Array.from(this.pending.values(), (entry) => entry.record).filter(
      (record) => record.resolvedAtMs === undefined,
    );
  }

  async lookupApprovalId(
    input: string,
    opts: {
      includeResolved?: boolean;
      authority?: ExecApprovalReadAuthority;
      filter?: (record: ExecApprovalRecord<TPayload>) => boolean;
    } = {},
  ): Promise<ExecApprovalIdLookupResult> {
    await this.listPendingRecords(opts.authority);
    return this.lookupLocalApprovalId(input, opts);
  }

  lookupLocalApprovalId(
    input: string,
    opts: {
      includeResolved?: boolean;
      filter?: (record: ExecApprovalRecord<TPayload>) => boolean;
    } = {},
  ): ExecApprovalIdLookupResult {
    const rawExact = this.getLocalSnapshot(input);
    if (rawExact) {
      return (opts.includeResolved || rawExact.resolvedAtMs === undefined) &&
        (opts.filter?.(rawExact) ?? true)
        ? { kind: "exact", id: input }
        : { kind: "none" };
    }
    const normalized = input.trim();
    if (!normalized) {
      return { kind: "none" };
    }
    const exact = this.getLocalSnapshot(normalized);
    if (exact) {
      return (opts.includeResolved || exact.resolvedAtMs === undefined) &&
        (opts.filter?.(exact) ?? true)
        ? { kind: "exact", id: normalized }
        : { kind: "none" };
    }
    const lowerPrefix = normalizeLowercaseStringOrEmpty(normalized);
    const candidates = new Map(
      Array.from(this.pending.values(), (entry) => [entry.record.id, entry.record] as const),
    );
    const matches: string[] = [];
    for (const [id, record] of candidates) {
      if (
        (!opts.includeResolved && record.resolvedAtMs !== undefined) ||
        opts.filter?.(record) === false
      ) {
        continue;
      }
      if (normalizeLowercaseStringOrEmpty(id).startsWith(lowerPrefix)) {
        matches.push(id);
      }
    }
    return matches.length === 1
      ? { kind: "prefix", id: expectDefined(matches[0], "approval prefix match") }
      : matches.length > 1
        ? { kind: "ambiguous", ids: matches }
        : { kind: "none" };
  }
}

export function prepareExecApprovalRedemptionWindow(
  record: ExecApprovalRecord<unknown>,
  graceAnchorMs: number | null,
  nowMs: number,
): number | null {
  const resolvedAtMs = record.resolvedAtMs;
  if (
    resolvedAtMs === undefined ||
    graceAnchorMs === null ||
    nowMs - graceAnchorMs >= EXEC_APPROVAL_RESOLVED_ENTRY_GRACE_MS ||
    record.decision !== "allow-once" ||
    record.consumedDecision
  ) {
    return null;
  }
  return EXEC_APPROVAL_RESOLVED_ENTRY_GRACE_MS + Math.max(0, graceAnchorMs - resolvedAtMs);
}
