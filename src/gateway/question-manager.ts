// Tracks operator questions in memory; an optional store lets restarts report dropped ones.
import { randomUUID } from "node:crypto";
import {
  resolveExpiresAtMsFromDurationMs,
  resolveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import type {
  Question,
  QuestionAnswers,
  QuestionRecord,
  QuestionResolvedEvent,
  QuestionResolveResult,
  QuestionWaitAnswerResult,
} from "../../packages/gateway-protocol/src/index.js";
import type { OperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import { bindMcpFormQuestionRecord } from "../agents/mcp-form-resource-context.js";
import { getAgentRunContext } from "../infra/agent-run-registry.js";
import type { GatewayScheduler, GatewayScheduledJob } from "../infra/gateway-scheduler.js";
import { hasSqliteWorkerOutcomeUnknown } from "../infra/sqlite-worker-contract.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  retainGatewayRootWorkAdmissionContinuationScope,
  type GatewayRootWorkAdmissionContinuationScope,
} from "../process/gateway-work-admission.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { canonicalizeQuestionAnswers } from "./question-answers.js";
import type {
  QuestionClientAuthorization,
  QuestionSessionAccess,
} from "./question-session-access.types.js";
import type { GatewayQuestionStore, StoredQuestion } from "./question-store.js";

/** Grace period for late question.waitAnswer and question.get calls. */
const QUESTION_RESOLVED_ENTRY_GRACE_MS = 15_000;
const log = createSubsystemLogger("gateway/questions");

export const QuestionManagerErrorCodes = {
  NOT_FOUND: "QUESTION_NOT_FOUND",
  ALREADY_TERMINAL: "QUESTION_ALREADY_TERMINAL",
  ID_IN_USE: "QUESTION_ID_IN_USE",
  INVALID_ANSWER: "QUESTION_INVALID_ANSWER",
  REQUESTER_INACTIVE: "QUESTION_REQUESTER_INACTIVE",
} as const;

type QuestionManagerErrorCode =
  (typeof QuestionManagerErrorCodes)[keyof typeof QuestionManagerErrorCodes];

export class QuestionManagerError extends Error {
  constructor(
    readonly code: QuestionManagerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "QuestionManagerError";
  }
}

type QuestionManagerRequest = {
  id?: string;
  questions: Question[];
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  timeoutMs: number;
  onResolved?:
    | ((event: QuestionResolvedEvent, observation: QuestionObservation) => void)
    | ((event: QuestionResolvedEvent, observation: QuestionObservation) => Promise<void>);
  /** Host-owned human decision boundary; never accepted from wire data. */
  authorizeClient?: QuestionClientAuthorization;
  sessionAccess?: QuestionSessionAccess;
  isRequesterActive?: () => boolean;
  requesterRun?: OperationalRunInstanceRef;
  /** Trusted handler binds the run; the manager owns expiry and terminal release. */
  registerHumanInputWait?: (isPending: () => boolean) => ((resolved: boolean) => void) | undefined;
};

type Waiter = () => void;

type QuestionEntry = {
  record: QuestionRecord;
  ordinary: boolean;
  resolutionId?: string;
  job: GatewayScheduledJob;
  waiters: Set<Waiter>;
  onResolved?: QuestionManagerRequest["onResolved"];
  /** Host-owned human decision boundary; never accepted from wire data. */
  authorizeClient?: QuestionClientAuthorization;
  sessionAccess?: QuestionSessionAccess;
  isRequesterActive?: () => boolean;
  requesterRun?: OperationalRunInstanceRef;
  admissionContinuation: GatewayRootWorkAdmissionContinuationScope | null;
  releaseHumanInputWait?: (resolved: boolean) => void;
  committing?: boolean;
  commitUnknown?: boolean;
  retired?: boolean;
  /** Serializes this entry's best-effort store writes. */
  persisted?: Promise<void>;
  stored?: StoredQuestion;
  /** Restored after a restart: its outcome continues the session instead of a waiting tool. */
  detached?: true;
};

/** A restored question's outcome, ready to continue its session in one new turn. */
export type RestoredQuestion = {
  stored: StoredQuestion & { sessionId: string };
  /** Called once the continuation turn is adopted; deletes the row. */
  onAdopted: () => Promise<void>;
};

/** Private entry identity. Never reselect a successor by its public question id. */
export type QuestionObservation = {
  readonly record: QuestionRecord;
  readonly ordinary: boolean;
  readonly sessionAccess?: QuestionSessionAccess;
  readonly authorizeClient?: QuestionClientAuthorization;
  isCurrent: () => boolean;
  refreshRequester: () => void;
};

function waitResult(entry: QuestionEntry, includeResolutionId: boolean): QuestionWaitAnswerResult {
  const { record, resolutionId } = entry;
  if (record.status !== "answered") {
    return { status: record.status };
  }
  // Legacy native decoders reject extra fields. Correlation is opt-in per
  // waiter, never exposed on records/events or used as resolution authority.
  return {
    status: "answered",
    answers: record.answers ?? { answers: {} },
    ...(includeResolutionId && resolutionId ? { resolutionId } : {}),
  };
}

function isOrdinary(questions: Question[]): boolean {
  return !questions.some((question) => question.isSecret || question.secretStore);
}

/** Process-local lifecycle owner for pending questions. */
export class QuestionManager {
  private readonly entries = new Map<string, QuestionEntry>();
  private closed = false;
  private readonly publications = new AsyncWorkScope();
  private readonly scheduleId = `questions:${randomUUID()}`;
  /** Restored questions whose continuation turn has not been adopted yet. */
  private readonly unadopted = new Map<string, QuestionRecord>();

  constructor(
    private readonly scheduler: GatewayScheduler,
    private readonly onPublicationError?: () => void,
    private readonly store?: GatewayQuestionStore,
    private readonly continueRestored?: (question: RestoredQuestion) => void,
  ) {}

  /**
   * Resumable questions come back pending until their original deadline; their outcome
   * continues the session. Others, dropped by the restart, stay visibly expired.
   */
  async restore(): Promise<void> {
    const rows = (await this.store?.list()) ?? [];
    const now = this.scheduler.now();
    for (const stored of rows) {
      const { record } = stored;
      if (this.closed || this.entries.has(record.id)) {
        continue;
      }
      const resumable = stored.resume === true && stored.sessionId !== undefined;
      const pending = resumable && record.status === "pending" && record.expiresAtMs > now;
      const entry: QuestionEntry = {
        record: !resumable
          ? { ...record, status: "expired", resolvedBy: "gateway-restart" }
          : record.status === "pending" && !pending
            ? { ...record, status: "expired" }
            : record,
        ordinary: isOrdinary(record.questions),
        stored,
        ...(resumable ? { detached: true as const } : {}),
        waiters: new Set(),
        admissionContinuation: null,
        job: this.scheduler.schedule({
          id: `${this.scheduleId}:${record.id}`,
          delayMs: pending
            ? record.expiresAtMs - now
            : Math.max(record.expiresAtMs - now, QUESTION_RESOLVED_ENTRY_GRACE_MS),
          run: () => {
            if (pending) {
              this.expire(record.id);
              return this.drain();
            }
            if (this.entries.get(record.id) === entry) {
              this.entries.delete(record.id);
              if (!resumable) {
                this.persist(entry, (store) => store.remove(record.id));
              }
            }
            return undefined;
          },
        }),
      };
      this.entries.set(record.id, entry);
      if (resumable) {
        this.unadopted.set(record.id, record);
        if (!pending) {
          // Answered or expired before a crash: continue the session now.
          this.continueEntry(entry);
        }
      }
    }
  }

  /** Restart resume defers to a restored question whose outcome will continue the session. */
  hasPendingResumable(agentId: string, sessionKey: string): boolean {
    return [...this.unadopted.values()].some(
      (record) =>
        record.sessionKey === sessionKey && (!record.agentId || record.agentId === agentId),
    );
  }

  /** An answer during shutdown would be lost; the next Gateway accepts it instead. */
  refusesAnswerWhileClosing(id: string): boolean {
    return this.scheduler.signal.aborted && this.entries.get(id)?.stored?.resume === true;
  }

  /** Restored questions commit their answer row before the continuation is admitted. */
  resolveRestored(
    id: string,
    answers: QuestionAnswers,
    resolvedBy?: string,
  ): Promise<QuestionResolveResult> | undefined {
    const entry = this.entries.get(id);
    const { store } = this;
    if (!entry?.detached || !entry.stored || !store) {
      return undefined;
    }
    const stored = entry.stored;
    return this.resolveWithCommit(id, answers, resolvedBy, {
      commit: () =>
        store.upsert({
          ...stored,
          record: {
            ...entry.record,
            status: "answered",
            answers: this.validateAnswers(entry.record.questions, answers),
            ...(resolvedBy ? { resolvedBy } : {}),
          },
        }),
    });
  }

  private continueEntry(entry: QuestionEntry): void {
    const { store, continueRestored } = this;
    const sessionId = entry.stored?.sessionId;
    if (!store || !continueRestored || !sessionId || this.closed || this.scheduler.signal.aborted) {
      return;
    }
    const { id } = entry.record;
    continueRestored({
      stored: { ...entry.stored, sessionId, record: entry.record },
      onAdopted: async () => {
        this.unadopted.delete(id);
        await store.remove(id).catch((error: unknown) => {
          log.warn(`question ${id} persistence failed: ${String(error)}`);
        });
      },
    });
  }

  /** Best effort and never awaited by RPCs. Shutdown keeps rows for the next Gateway. */
  private persist(entry: QuestionEntry, write: (store: GatewayQuestionStore) => Promise<void>) {
    const store = this.store;
    if (!store || this.closed || this.scheduler.signal.aborted) {
      return;
    }
    const previous = entry.persisted ?? Promise.resolve();
    entry.persisted = this.publications
      .track(() => previous.then(() => write(store)))
      .catch((error: unknown) => {
        log.warn(`question ${entry.record.id} persistence failed: ${String(error)}`);
      });
  }

  async drain(): Promise<void> {
    if (this.closed) {
      await this.publications.drain();
    } else {
      await AsyncWorkScope.runWhenAllIdle(
        () => [this.publications],
        () => {},
      );
    }
  }

  request(params: QuestionManagerRequest): QuestionRecord {
    if (this.closed) {
      throw new Error("Question manager is closed");
    }
    if (params.isRequesterActive && !params.isRequesterActive()) {
      throw new QuestionManagerError(
        QuestionManagerErrorCodes.REQUESTER_INACTIVE,
        "the agent run that requested this question is no longer active",
      );
    }
    const createdAtMs = this.scheduler.now();
    const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 1);
    const expiresAtMs = resolveExpiresAtMsFromDurationMs(timeoutMs, { nowMs: createdAtMs });
    if (expiresAtMs === undefined) {
      throw new Error("question expiry is unavailable");
    }
    const id = params.id ?? randomUUID();
    if (this.entries.has(id)) {
      throw new QuestionManagerError(
        QuestionManagerErrorCodes.ID_IN_USE,
        `question '${id}' already exists`,
      );
    }
    const record: QuestionRecord = {
      id,
      questions: params.questions,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      ...(params.runId ? { runId: params.runId } : {}),
      createdAtMs,
      expiresAtMs,
      status: "pending",
    };
    const entry: QuestionEntry = {
      record,
      ordinary: isOrdinary(params.questions),
      job: this.scheduler.schedule({
        id: `${this.scheduleId}:${id}`,
        delayMs: timeoutMs,
        run: () => {
          this.expire(id);
          return this.drain();
        },
      }),
      waiters: new Set(),
      onResolved: params.onResolved,
      sessionAccess: params.sessionAccess,
      authorizeClient: params.authorizeClient,
      isRequesterActive: params.isRequesterActive,
      requesterRun: params.requesterRun,
      admissionContinuation: retainGatewayRootWorkAdmissionContinuationScope(),
    };
    this.entries.set(record.id, entry);
    const sessionId = params.runId ? getAgentRunContext(params.runId)?.sessionId : undefined;
    // Ordinary session questions (ask_user, harness) can continue their session after a
    // restart; secret, form, and host-authorized questions only report that they expired.
    const resume =
      entry.ordinary &&
      !params.authorizeClient &&
      params.sessionKey &&
      sessionId &&
      !params.questions.some((question) => question.presentation);
    const stored: StoredQuestion = {
      record,
      ...(sessionId ? { sessionId } : {}),
      ...(resume ? { resume: true } : {}),
    };
    entry.stored = stored;
    this.persist(entry, (store) => store.upsert(stored));
    bindMcpFormQuestionRecord(
      record,
      () =>
        this.entries.get(record.id) === entry &&
        entry.record === record &&
        entry.record.status === "pending",
    );
    entry.releaseHumanInputWait = params.registerHumanInputWait?.(
      () => this.get(id)?.status === "pending" && this.entries.get(id) === entry,
    );
    return record;
  }

  get(id: string): QuestionRecord | null {
    const entry = this.entries.get(id);
    if (!entry) {
      return null;
    }
    if (entry.record.status === "pending" && entry.record.expiresAtMs <= this.scheduler.now()) {
      this.expire(id);
    }
    this.refreshRequester(entry);
    return this.entries.get(id) === entry ? entry.record : null;
  }

  /** Observation only: unlike get(), this cannot expire or cancel and recursively broadcast. */
  observe(id: string, expectedRecord?: QuestionRecord): QuestionObservation | null {
    const entry = this.entries.get(id);
    if (!entry || (expectedRecord && entry.record !== expectedRecord)) {
      return null;
    }
    return this.observeEntry(entry);
  }

  private observeEntry(entry: QuestionEntry): QuestionObservation {
    return {
      get record() {
        return entry.record;
      },
      ordinary: entry.ordinary,
      sessionAccess: entry.sessionAccess,
      authorizeClient: entry.authorizeClient,
      isCurrent: () => this.entries.get(entry.record.id) === entry,
      refreshRequester: () => this.refreshRequester(entry),
    };
  }

  private refreshRequester(entry: QuestionEntry): void {
    if (
      this.entries.get(entry.record.id) !== entry ||
      entry.record.status !== "pending" ||
      entry.committing
    ) {
      return;
    }
    const active = entry.isRequesterActive?.();
    // Liveness can reset/reuse the public id or settle the captured entry reentrantly.
    // A worker-confirmed source loss must retire only this still-pending observation.
    if (
      active === false &&
      this.entries.get(entry.record.id) === entry &&
      entry.record.status === "pending"
    ) {
      this.cancelEntry(entry, "requester-inactive");
    }
  }

  /** Called by the Gateway's existing authority-close observer. */
  cancelClosedAuthorities(closedRun?: { runId: string; instanceId?: string }): void {
    for (const [id, entry] of this.entries) {
      if (
        closedRun &&
        entry.requesterRun &&
        (entry.requesterRun.runId !== closedRun.runId ||
          (closedRun.instanceId !== undefined &&
            entry.requesterRun.instanceId !== closedRun.instanceId))
      ) {
        continue;
      }
      this.get(id);
    }
  }

  list(include?: (record: QuestionRecord) => boolean): QuestionRecord[] {
    const records: QuestionRecord[] = [];
    for (const [id, entry] of this.entries) {
      if (include && !include(entry.record)) {
        continue;
      }
      const record = this.get(id);
      if (record?.status === "pending") {
        records.push(record);
      }
    }
    return records.toSorted(
      (left, right) => left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id),
    );
  }

  /** Re-enters only the still-pending question's original admitted root. */
  runPendingContinuation<T>(id: string, run: () => Promise<T>): Promise<T> | null {
    const record = this.get(id);
    const entry = this.entries.get(id);
    if (
      !entry?.admissionContinuation ||
      entry.record !== record ||
      entry.record.status !== "pending" ||
      entry.record.expiresAtMs <= this.scheduler.now()
    ) {
      return null;
    }
    return entry.admissionContinuation.run(run);
  }

  waitAnswer(
    id: string,
    timeoutMs?: number,
    includeResolutionId = false,
  ): Promise<QuestionWaitAnswerResult> {
    const entry = this.requireEntry(id);
    if (entry.record.status !== "pending") {
      return Promise.resolve(waitResult(entry, includeResolutionId));
    }
    const signal = getAsyncWorkSignal();
    return new Promise<QuestionWaitAnswerResult>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter: Waiter = () => {
        if (!entry.waiters.delete(waiter)) {
          return;
        }
        clearTimeout(timer);
        signal?.removeEventListener("abort", waiter);
        // finish() may close this observer after recording an answer. Read that
        // fact directly; get() could expire/cancel the question during retirement.
        resolve(waitResult(entry, includeResolutionId));
      };
      entry.waiters.add(waiter);
      if (signal?.aborted) {
        waiter();
        return;
      }
      signal?.addEventListener("abort", waiter, { once: true });
      if (timeoutMs !== undefined) {
        timer = setTimeout(waiter, resolveTimerTimeoutMs(timeoutMs, 1)).unref();
      }
    });
  }

  resolve(
    id: string,
    answers: QuestionAnswers,
    resolvedBy?: string,
    options?: { commit?: () => void; resolutionId?: string },
  ): QuestionResolveResult {
    const entry = this.requirePendingEntry(id);
    const canonical = this.validateAnswers(entry.record.questions, answers);
    // The commit, receipt, and answered transition are synchronous. Failed
    // validation/writes must not publish a receipt; lost ACKs must not erase it.
    options?.commit?.();
    entry.resolutionId = options?.resolutionId;
    entry.record = {
      ...entry.record,
      status: "answered",
      answers: canonical,
      ...(resolvedBy ? { resolvedBy } : {}),
    };
    void this.finish(entry);
    return { status: "answered", answers: canonical };
  }

  /** Async persistence keeps the v2026.8.1 SDK's ordinary resolve() synchronous. */
  resolveWithCommit(
    id: string,
    answers: QuestionAnswers,
    resolvedBy: string | undefined,
    options: { commit: (assertCurrent: () => void) => Promise<void>; resolutionId?: string },
  ): Promise<QuestionResolveResult> {
    const entry = this.requirePendingEntry(id);
    const canonical = this.validateAnswers(entry.record.questions, answers);
    entry.committing = true;
    const assertCurrent = () => {
      const active = entry.isRequesterActive?.();
      if (
        this.closed ||
        entry.retired ||
        this.entries.get(id) !== entry ||
        entry.record.status !== "pending" ||
        entry.record.expiresAtMs <= this.scheduler.now() ||
        active === false
      ) {
        throw new QuestionManagerError(
          QuestionManagerErrorCodes.REQUESTER_INACTIVE,
          "the question's resolution authority is no longer active",
        );
      }
    };
    return this.publications.track(async () => {
      try {
        assertCurrent();
        await options.commit(assertCurrent);
        // A known commit owns the terminal fact even if authority retires before its ACK arrives.
        entry.resolutionId = options.resolutionId;
        entry.record = {
          ...entry.record,
          status: "answered",
          answers: canonical,
          ...(resolvedBy ? { resolvedBy } : {}),
        };
        await this.finish(entry);
        return { status: "answered", answers: canonical };
      } catch (error) {
        entry.commitUnknown = hasSqliteWorkerOutcomeUnknown(error);
        throw error;
      } finally {
        entry.committing = false;
        if (entry.retired) {
          this.releaseEntry(entry);
        } else {
          this.get(id);
        }
      }
    });
  }

  cancel(id: string, resolvedBy?: string): QuestionResolveResult {
    const entry = this.requirePendingEntry(id);
    return this.cancelEntry(entry, resolvedBy);
  }

  private cancelEntry(entry: QuestionEntry, resolvedBy?: string): QuestionResolveResult {
    entry.record = {
      ...entry.record,
      status: "cancelled",
      ...(resolvedBy ? { resolvedBy } : {}),
    };
    void this.finish(entry);
    return { status: "cancelled" };
  }

  /** Retires this Gateway's owner only after received mutations have joined. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.publications.beginClose();
    this.reset();
  }

  /** Reusable on open owners (v2026.8.1 SDK context); never reopens a closed owner. */
  reset(): void {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) {
      if (entry.committing) {
        entry.retired = true;
        entry.job.cancel();
      }
    }
    for (const entry of entries) {
      if (!entry.committing) {
        this.releaseEntry(entry);
      }
    }
  }

  private releaseEntry(entry: QuestionEntry): void {
    if (this.entries.get(entry.record.id) === entry) {
      this.entries.delete(entry.record.id);
    }
    entry.sessionAccess?.release();
    entry.job.cancel();
    const releaseHumanInputWait = entry.releaseHumanInputWait;
    entry.releaseHumanInputWait = undefined;
    releaseHumanInputWait?.(false);
    entry.admissionContinuation?.release();
    entry.admissionContinuation = null;
    for (const waiter of entry.waiters) {
      waiter();
    }
  }

  private requireEntry(id: string): QuestionEntry {
    // get() settles expiry/requester loss; its callbacks can replace the entry.
    const record = this.get(id);
    const entry = this.entries.get(id);
    if (!record || !entry || entry.record !== record) {
      throw new QuestionManagerError(
        QuestionManagerErrorCodes.NOT_FOUND,
        `question '${id}' was not found`,
      );
    }
    return entry;
  }

  private requirePendingEntry(id: string): QuestionEntry {
    const entry = this.requireEntry(id);
    if (entry.record.status !== "pending" || entry.committing || entry.commitUnknown) {
      throw new QuestionManagerError(
        QuestionManagerErrorCodes.ALREADY_TERMINAL,
        entry.commitUnknown
          ? `question '${id}' has an unknown write outcome; do not resubmit this answer`
          : entry.committing
            ? `question '${id}' is already being resolved`
            : `question '${id}' is already ${entry.record.status}`,
      );
    }
    return entry;
  }

  /** Validates answers against stored questions and returns them in canonical form. */
  private validateAnswers(questions: Question[], answers: QuestionAnswers): QuestionAnswers {
    return canonicalizeQuestionAnswers(
      questions,
      answers,
      (id, reason) =>
        new QuestionManagerError(
          QuestionManagerErrorCodes.INVALID_ANSWER,
          `question '${id}' ${reason}`,
        ),
    );
  }

  private expire(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || entry.record.status !== "pending" || entry.committing) {
      return;
    }
    entry.record = { ...entry.record, status: "expired" };
    void this.finish(entry);
  }

  private finish(entry: QuestionEntry): Promise<void> {
    entry.job.cancel();
    if (entry.detached) {
      this.continueEntry(entry);
    } else {
      this.persist(entry, (store) => store.remove(entry.record.id));
    }
    const continuation = entry.admissionContinuation;
    entry.admissionContinuation = null;
    let settled = false;
    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      const releaseHumanInputWait = entry.releaseHumanInputWait;
      entry.releaseHumanInputWait = undefined;
      try {
        releaseHumanInputWait?.(entry.isRequesterActive?.() !== false);
      } finally {
        entry.isRequesterActive = undefined;
        for (const waiter of entry.waiters) {
          waiter();
        }
      }
    };
    const publish = async () => {
      try {
        // Enter the original continuation before these callbacks can release its last parked root.
        settle();
        const { id, status, answers } = entry.record;
        if (status !== "pending" && this.entries.get(id) === entry) {
          const event: QuestionResolvedEvent =
            status === "answered"
              ? { id, status, answers: answers ?? { answers: {} } }
              : { id, status };
          await entry.onResolved?.(event, this.observeEntry(entry));
        }
      } finally {
        continuation?.release();
      }
    };
    // Track before invoking: synchronous truth and callbacks retain their ordering,
    // while worker preparation and rejected publication are joined by Gateway shutdown.
    return this.publications
      .track(async () => {
        try {
          let publication: Promise<void>;
          try {
            publication = continuation ? continuation.run(publish) : publish();
          } finally {
            // Root reset can refuse entry before publish starts. Local waiters still
            // observe the committed terminal fact without admitting another root.
            settle();
          }
          await publication;
        } finally {
          // Worker preparation still needs this entry. Start grace only after
          // publication settles, and never resurrect an entry retired by a callback.
          if (this.entries.get(entry.record.id) === entry) {
            entry.job = this.scheduler.schedule({
              id: `${this.scheduleId}:${entry.record.id}`,
              delayMs: QUESTION_RESOLVED_ENTRY_GRACE_MS,
              run: () => {
                if (this.entries.get(entry.record.id) === entry) {
                  this.entries.delete(entry.record.id);
                  entry.sessionAccess?.release();
                }
              },
            });
          }
        }
      })
      .catch(() => {
        continuation?.release();
        this.onPublicationError?.();
      });
  }
}
