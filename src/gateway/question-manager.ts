import { randomUUID } from "node:crypto";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import type {
  Question,
  QuestionAnswers,
  QuestionRecord,
  QuestionResolvedEvent,
  QuestionResolveResult,
  QuestionWaitAnswerResult,
} from "../../packages/gateway-protocol/src/index.js";
import { bindMcpFormQuestionRecord } from "../agents/mcp-form-resource-context.js";
import { hasSessionQuestionCustodyRetiredError } from "../config/sessions/session-questions-custody-error.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { hasSqliteWorkerOutcomeUnknown } from "../infra/sqlite-worker-contract.js";
import { retainGatewayRootWorkAdmissionContinuationScope } from "../process/gateway-work-admission.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { validateQuestionAnswers } from "./question-answers.js";
import {
  invalidQuestionAnswerError,
  QuestionManagerError,
  QuestionManagerErrorCodes,
} from "./question-manager.errors.js";
import type {
  QuestionEntry,
  QuestionManagerRequest,
  QuestionObservation,
  Waiter,
} from "./question-manager.types.js";
import {
  QuestionRegistrationReservations,
  resolveQuestionRequestTiming,
  type QuestionRegistrationReservation,
} from "./question-registration-reservations.js";
import { questionWaitResult } from "./question-wait-result.js";
export type { DurableQuestionCustody, QuestionObservation } from "./question-manager.types.js";
export { QuestionManagerError, QuestionManagerErrorCodes } from "./question-manager.errors.js";

const QUESTION_RESOLVED_ENTRY_GRACE_MS = 15_000;

export class QuestionManager {
  private readonly entries = new Map<string, QuestionEntry>();
  private readonly registrations = new QuestionRegistrationReservations((id) =>
    this.entries.has(id),
  );
  private closed = false;
  private custodyGeneration = 0;
  private readonly publications = new AsyncWorkScope();
  private readonly scheduleId = `questions:${randomUUID()}`;

  constructor(
    private readonly scheduler: GatewayScheduler,
    private readonly onPublicationError?: () => void,
  ) {}

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

  reserveRegistration(id?: string): QuestionRegistrationReservation {
    if (this.closed) {
      throw new Error("Question manager is closed");
    }
    return this.registrations.reserve(id);
  }

  request(params: QuestionManagerRequest): QuestionRecord {
    if (this.closed) {
      throw new Error("Question manager is closed");
    }
    if (!params.durableCustody && params.isRequesterActive && !params.isRequesterActive()) {
      throw new QuestionManagerError(
        QuestionManagerErrorCodes.REQUESTER_INACTIVE,
        "the agent run that requested this question is no longer active",
      );
    }
    const { id, createdAtMs, expiresAtMs } = resolveQuestionRequestTiming(
      params,
      this.scheduler.now(),
    );
    this.registrations.assertAvailable(id, params.registrationReservation);
    const record: QuestionRecord = params.storedRecord ?? {
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
      durableCustody: params.durableCustody,
      resolutionId: params.storedResolutionId,
      ordinary: !params.questions.some((question) => question.isSecret || question.secretStore),
      job: this.scheduler.schedule({
        id: `${this.scheduleId}:${id}`,
        delayMs: Math.max(1, expiresAtMs - this.scheduler.now()),
        run: () => {
          this.expire(id);
          return this.drain();
        },
      }),
      waiters: new Set(),
      onResolved: params.onResolved,
      sessionAccess: params.sessionAccess,
      authorizeClient: params.authorizeClient,
      isRequesterActive: params.durableCustody ? undefined : params.isRequesterActive,
      requesterRun: params.durableCustody ? undefined : params.requesterRun,
      admissionContinuation: params.durableCustody
        ? null
        : retainGatewayRootWorkAdmissionContinuationScope(),
    };
    if (record.status !== "pending") {
      entry.job.cancel();
    }
    this.entries.set(record.id, entry);
    bindMcpFormQuestionRecord(
      record,
      () =>
        this.entries.get(record.id) === entry &&
        entry.record === record &&
        entry.record.status === "pending",
    );
    entry.releaseHumanInputWait = !params.durableCustody
      ? params.registerHumanInputWait?.(
          () => this.get(id)?.status === "pending" && this.entries.get(id) === entry,
        )
      : undefined;
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
      durableDefinition: entry.durableCustody?.definition,
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

  /** Private process lifetime for custody repair, independent of a transport caller. */
  captureCustodyCurrent(): () => void {
    const generation = this.custodyGeneration;
    return () => {
      if (this.closed || generation !== this.custodyGeneration) {
        throw new Error("Question Gateway custody owner retired");
      }
    };
  }

  list(include?: (record: QuestionRecord) => boolean, includeTerminal = false): QuestionRecord[] {
    const records: QuestionRecord[] = [];
    for (const [id, entry] of this.entries) {
      if (include && !include(entry.record)) {
        continue;
      }
      const record = this.get(id);
      if (record && (record.status === "pending" || includeTerminal)) {
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
      return Promise.resolve(questionWaitResult(entry, includeResolutionId));
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
        resolve(questionWaitResult(entry, includeResolutionId));
      };
      entry.waiters.add(waiter);
      if (signal?.aborted) {
        waiter();
        return;
      }
      signal?.addEventListener("abort", waiter, { once: true });
      if (timeoutMs !== undefined) {
        timer = setTimeout(waiter, resolveTimerTimeoutMs(timeoutMs, 1));
        timer.unref?.();
      }
    });
  }

  /** Durable ordinary questions outlive their asking run, never its executable authority. */
  hasDurableCustody(id: string): boolean {
    return Boolean(this.entries.get(id)?.durableCustody);
  }

  /** Retire a native-confirmed lost custody observation without inventing terminal truth. */
  retireDurableCustodyObservation(observation: QuestionObservation): void {
    const entry = this.entries.get(observation.record.id);
    if (!entry?.durableCustody || !observation.isCurrent() || entry.record !== observation.record) {
      return;
    }
    if (entry.committing) {
      entry.retired = true;
      this.entries.delete(entry.record.id);
      entry.job.cancel();
    } else {
      this.releaseEntry(entry);
    }
  }

  /** Canonical terminal receipt retention is absolute, including after restoration. */
  retireDurableObservationAt(observation: QuestionObservation, retainUntilMs: number): void {
    const entry = this.entries.get(observation.record.id);
    if (!entry?.durableCustody || entry.record.status === "pending" || !observation.isCurrent()) {
      return;
    }
    entry.job.cancel();
    entry.job = this.scheduler.schedule({
      id: `${this.scheduleId}:${entry.record.id}`,
      delayMs: Math.max(1, retainUntilMs - this.scheduler.now()),
      run: () => {
        if (observation.isCurrent()) {
          this.entries.delete(entry.record.id);
          this.releaseEntry(entry);
        }
      },
    });
  }

  async settleDurable(
    id: string,
    outcome:
      | { status: "answered"; answers: QuestionAnswers; resolvedBy?: string; resolutionId?: string }
      | { status: "cancelled" | "expired"; resolvedBy?: string },
    assertAuthorized: () => void,
  ): Promise<QuestionResolveResult | { status: "expired" }> {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new QuestionManagerError(
        QuestionManagerErrorCodes.NOT_FOUND,
        `question '${id}' not found`,
      );
    }
    const custody = entry.durableCustody;
    if (!custody) {
      throw new Error("Question has no durable custody");
    }
    if (entry.committing) {
      throw new QuestionManagerError(
        QuestionManagerErrorCodes.ALREADY_TERMINAL,
        "Question settlement is already in progress; read its committed outcome.",
      );
    }
    const canonical =
      outcome.status === "answered"
        ? { ...outcome, answers: this.validateAnswers(entry.record.questions, outcome.answers) }
        : outcome;
    const assertCustodyCurrent = () => {
      if (this.closed || entry.retired || this.entries.get(id) !== entry) {
        throw new QuestionManagerError(
          QuestionManagerErrorCodes.REQUESTER_INACTIVE,
          "Question custody was retired before settlement.",
        );
      }
    };
    const assertCurrent = () => {
      assertAuthorized();
      assertCustodyCurrent();
    };
    entry.committing = true;
    try {
      return await this.publications.track(async () => {
        assertCurrent();
        // The store reconciles unknown worker outcomes and returns canonical truth.
        // A known commit survives authority retirement before its response arrives.
        const committed = await custody.settle(canonical, assertCurrent, assertCustodyCurrent);
        entry.record = committed.record;
        entry.resolutionId = committed.resolutionId;
        if (entry.record.status === "pending") {
          throw new Error("Durable settlement returned a pending question");
        }
        await this.finish(entry);
        custody.onContinuationOwed();
        return entry.record.status === "answered"
          ? { status: "answered", answers: entry.record.answers ?? { answers: {} } }
          : { status: entry.record.status };
      });
    } finally {
      entry.committing = false;
      if (entry.retired) {
        this.releaseEntry(entry);
      } else if (
        outcome.status !== "expired" &&
        this.entries.get(id) === entry &&
        entry.record.expiresAtMs <= this.scheduler.now()
      ) {
        // A deadline consumed during a failed answer commit still needs one expiry attempt.
        this.expire(id);
      }
    }
  }

  resolve(
    id: string,
    answers: QuestionAnswers,
    resolvedBy?: string,
    options?: { commit?: () => void; resolutionId?: string },
  ): QuestionResolveResult {
    const entry = this.requirePendingEntry(id);
    if (entry.durableCustody) {
      throw new Error("Durable questions require asynchronous committed settlement");
    }
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
    if (entry.durableCustody) {
      throw new Error("Durable questions require asynchronous committed settlement");
    }
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
    this.custodyGeneration++;
    this.registrations.reset();
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
    return validateQuestionAnswers(questions, answers, invalidQuestionAnswerError);
  }

  private expire(id: string): void {
    const entry = this.entries.get(id);
    if (
      !entry ||
      entry.record.status !== "pending" ||
      entry.committing ||
      (entry.expiryRetryAtMs !== undefined && entry.expiryRetryAtMs > this.scheduler.now())
    ) {
      return;
    }
    if (entry.durableCustody) {
      void this.settleDurable(id, { status: "expired" }, () => {}).catch((error: unknown) => {
        if (hasSessionQuestionCustodyRetiredError(error) && this.entries.get(id) === entry) {
          // Native custody retirement is definitive; never retry against a successor.
          entry.retired = true;
          this.releaseEntry(entry);
          return;
        }
        if (
          this.closed ||
          entry.retired ||
          this.entries.get(id) !== entry ||
          entry.record.status !== "pending"
        ) {
          return;
        }
        // Retry the missed canonical expiry through its existing lifecycle job.
        // The public absolute deadline never changes, and reads cannot bypass this backoff.
        entry.expiryRetryAttempt = Math.min((entry.expiryRetryAttempt ?? 0) + 1, 7);
        const delayMs = Math.min(60_000, 1_000 * 2 ** (entry.expiryRetryAttempt - 1));
        entry.expiryRetryAtMs = this.scheduler.now() + delayMs;
        entry.job.cancel();
        entry.job = this.scheduler.schedule({
          id: `${this.scheduleId}:${id}`,
          delayMs,
          run: () => {
            if (!this.closed && !entry.retired && this.entries.get(id) === entry) {
              this.expire(id);
            }
            return this.drain();
          },
        });
        try {
          this.onPublicationError?.();
        } catch {
          // A reporting callback cannot discard the lifecycle job already retained above.
        }
      });
      return;
    }
    entry.record = { ...entry.record, status: "expired" };
    void this.finish(entry);
  }

  private finish(entry: QuestionEntry): Promise<void> {
    entry.job.cancel();
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
          if (!entry.durableCustody && this.entries.get(entry.record.id) === entry) {
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
