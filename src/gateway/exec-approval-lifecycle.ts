import { expectDefined } from "@openclaw/normalization-core";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { ExecApprovalDecision } from "../infra/exec-approvals.js";
import {
  captureGatewayRootWorkAdmissionContinuationScope,
  runWithRetainedGatewayRootWork,
  type GatewayRootWorkAdmissionContinuationScope,
} from "../process/gateway-work-admission.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import type {
  ExecApprovalIdLookupResult,
  ExecApprovalRecord,
  ExecApprovalResolutionSource,
  OperatorApprovalLifecycleEvent,
} from "./exec-approval-manager.types.js";
import type {
  OperatorApprovalRecord,
  OperatorApprovalResolver,
  OperatorApprovalStatus,
  OperatorApprovalTerminalReason,
} from "./operator-approval-store.js";

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

type PendingEntry<TPayload> = {
  record: ExecApprovalRecord<TPayload>;
  resolve: (decision: ExecApprovalDecision | null) => void;
  timer: ReturnType<typeof setTimeout> | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  handoffRetainCount: number;
  handoffReleasedAtMs: number | null;
  retainForManagerLifetime: boolean;
  promise: Promise<ExecApprovalDecision | null>;
  handoffs: Set<DecisionHandoff>;
  admissionContinuation: GatewayRootWorkAdmissionContinuationScope | null;
  mutation?: Promise<void>;
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

  abstract get runtimeEpoch(): string;
  protected abstract expireDue(recordId: string): Promise<boolean>;
  protected abstract reportError(
    error: unknown,
    context: { approvalId: string; operation: "expire" },
  ): void;

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
      clearTimeout(entry.timer ?? undefined);
      clearTimeout(entry.cleanupTimer ?? undefined);
      entry.timer = null;
      entry.cleanupTimer = null;
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
      timer: null,
      cleanupTimer: null,
      handoffRetainCount: 0,
      handoffReleasedAtMs: null,
      retainForManagerLifetime: false,
      promise: decision.promise,
      handoffs: new Set(),
      admissionContinuation: captureGatewayRootWorkAdmissionContinuationScope(),
    };
    this.pending.set(record.id, entry);
    this.scheduleExpiryTimer(entry);
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
    clearTimeout(pending.timer ?? undefined);
    pending.timer = null;
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
      entry.cleanupTimer ||
      entry.record.resolvedAtMs === undefined ||
      entry.retainForManagerLifetime ||
      entry.handoffRetainCount > 0
    ) {
      return;
    }
    const cleanupTimer = setTimeout(() => {
      if (entry.cleanupTimer !== cleanupTimer) {
        return;
      }
      entry.cleanupTimer = null;
      if (this.pending.get(entry.record.id) === entry && entry.handoffRetainCount === 0) {
        this.pending.delete(entry.record.id);
      }
    }, EXEC_APPROVAL_RESOLVED_ENTRY_GRACE_MS);
    cleanupTimer.unref?.();
    entry.cleanupTimer = cleanupTimer;
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
    clearTimeout(entry.cleanupTimer ?? undefined);
    entry.cleanupTimer = null;
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

  protected scheduleExpiryTimer(entry: PendingEntry<TPayload>): void {
    if (this.retired) {
      return;
    }
    entry.timer = setTimeout(
      () => {
        if (this.retired || this.pending.get(entry.record.id) !== entry) {
          return;
        }
        void this.expireDue(entry.record.id).catch((error: unknown) => {
          this.reportError(error, { approvalId: entry.record.id, operation: "expire" });
        });
      },
      resolveTimerTimeoutMs(entry.record.expiresAtMs - Date.now(), 1),
    );
  }

  async getSnapshot(recordId: string): Promise<ExecApprovalRecord<TPayload> | null> {
    const record = this.getLocalSnapshot(recordId);
    if (
      !this.retired &&
      record &&
      record.resolvedAtMs === undefined &&
      record.expiresAtMs <= Date.now()
    ) {
      await this.expireDue(recordId);
    }
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

  async listPendingRecords(): Promise<ExecApprovalRecord<TPayload>[]> {
    if (this.retired) {
      return [];
    }
    const nowMs = Date.now();
    for (const entry of this.pending.values()) {
      if (entry.record.resolvedAtMs === undefined && entry.record.expiresAtMs <= nowMs) {
        await this.expireDue(entry.record.id);
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
      filter?: (record: ExecApprovalRecord<TPayload>) => boolean;
    } = {},
  ): Promise<ExecApprovalIdLookupResult> {
    await this.listPendingRecords();
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
