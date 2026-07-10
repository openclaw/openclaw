// Gateway question manager.
// Tracks pending model->user structured questions and short-lived resolved records.
// Mirrors ExecApprovalManager: registration is synchronous, waiting is async, and a
// promise parks the asking tool (not the turn) until any surface resolves or expires.
import { randomUUID } from "node:crypto";
import type { AgentHarnessUserInputQuestion } from "../agents/harness/user-input-bridge.js";

/** One answered question keyed by the model-facing question id. */
export type QuestionAnswer = { text: string };

/** Answers for every question in a record, keyed by question id. */
export type QuestionAnswers = Record<string, QuestionAnswer>;

export type QuestionRecordStatus = "pending" | "resolved" | "expired";

/** Turn-source routing metadata copied from the asking run so any surface can reply. */
export type QuestionTurnSource = {
  turnSourceChannel?: string | null;
  turnSourceTo?: string | null;
  turnSourceAccountId?: string | null;
  turnSourceThreadId?: string | number | null;
};

export type QuestionRecord = QuestionTurnSource & {
  id: string;
  sessionKey?: string | null;
  agentId?: string | null;
  createdAtMs: number;
  // No expiry by default: a human may be asleep. Honored only when a caller sets it.
  expiresAtMs?: number | null;
  questions: readonly AgentHarnessUserInputQuestion[];
  status: QuestionRecordStatus;
  resolvedAtMs?: number;
  answers?: QuestionAnswers;
  resolvedBy?: string | null;
};

/** Fields a caller supplies to open a pending question. */
export type QuestionRegisterInput = QuestionTurnSource & {
  id?: string | null;
  sessionKey?: string | null;
  agentId?: string | null;
  expiresAtMs?: number | null;
  questions: readonly AgentHarnessUserInputQuestion[];
};

/** Side-effect hooks the gateway binds to broadcast events and deliver to channels. */
export type QuestionEmitter = {
  onPending?: (record: QuestionRecord) => void;
  onResolved?: (record: QuestionRecord, answers: QuestionAnswers) => void;
  onExpired?: (record: QuestionRecord, reason: string) => void;
};

/** Grace period to keep resolved entries for late list/lookups after the answer lands. */
const RESOLVED_ENTRY_GRACE_MS = 15_000;

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const unref = (timer as { unref?: () => void }).unref;
  if (typeof unref === "function") {
    unref.call(timer);
  }
}

type PendingEntry = {
  record: QuestionRecord;
  resolve: (answers: QuestionAnswers | null) => void;
  timer: ReturnType<typeof setTimeout> | null;
  promise: Promise<QuestionAnswers | null>;
};

export class QuestionManager {
  private pending = new Map<string, PendingEntry>();
  private emitter: QuestionEmitter | null = null;

  /** Binds the gateway broadcast/delivery hooks. Replaces any prior emitter. */
  setEmitter(emitter: QuestionEmitter | null): void {
    this.emitter = emitter;
  }

  /**
   * Register a pending question and return a promise resolved when any surface answers
   * or the record expires (`null`). Registration is synchronous so the id is live before
   * the emitter fans out the `pending` event.
   */
  register(input: QuestionRegisterInput): {
    record: QuestionRecord;
    wait: Promise<QuestionAnswers | null>;
  } {
    const now = Date.now();
    const id = input.id && input.id.trim().length > 0 ? input.id.trim() : randomUUID();
    if (this.pending.has(id)) {
      throw new Error(`question id '${id}' already pending`);
    }
    const record: QuestionRecord = {
      id,
      sessionKey: input.sessionKey ?? null,
      agentId: input.agentId ?? null,
      turnSourceChannel: input.turnSourceChannel ?? null,
      turnSourceTo: input.turnSourceTo ?? null,
      turnSourceAccountId: input.turnSourceAccountId ?? null,
      turnSourceThreadId: input.turnSourceThreadId ?? null,
      createdAtMs: now,
      expiresAtMs: input.expiresAtMs ?? null,
      questions: input.questions,
      status: "pending",
    };
    let resolvePromise: (answers: QuestionAnswers | null) => void;
    const promise = new Promise<QuestionAnswers | null>((resolve) => {
      resolvePromise = resolve;
    });
    const entry: PendingEntry = {
      record,
      resolve: resolvePromise!,
      timer: null,
      promise,
    };
    // Only arm a timer when an explicit expiry was requested; default is no timeout.
    if (typeof record.expiresAtMs === "number" && record.expiresAtMs > now) {
      const timer = setTimeout(() => this.expire(id, "timeout"), record.expiresAtMs - now);
      unrefTimer(timer);
      entry.timer = timer;
    }
    this.pending.set(id, entry);
    // Fan out after the entry is registered so a synchronous resolver can find the id.
    this.emitter?.onPending?.(record);
    return { record, wait: promise };
  }

  /** Resolve a pending question with answers. Returns false when unknown/already resolved. */
  resolve(id: string, answers: QuestionAnswers, resolvedBy?: string | null): boolean {
    const entry = this.pending.get(id);
    if (!entry || entry.record.status !== "pending") {
      return false;
    }
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    entry.record.status = "resolved";
    entry.record.resolvedAtMs = Date.now();
    entry.record.answers = answers;
    entry.record.resolvedBy = resolvedBy ?? null;
    entry.resolve(answers);
    this.emitter?.onResolved?.(entry.record, answers);
    this.scheduleCleanup(id, entry);
    return true;
  }

  /** Expire a pending question (no answer). Returns false when unknown/already resolved. */
  expire(id: string, reason: string): boolean {
    const entry = this.pending.get(id);
    if (!entry || entry.record.status !== "pending") {
      return false;
    }
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    entry.record.status = "expired";
    entry.record.resolvedAtMs = Date.now();
    entry.resolve(null);
    this.emitter?.onExpired?.(entry.record, reason);
    this.scheduleCleanup(id, entry);
    return true;
  }

  private scheduleCleanup(id: string, entry: PendingEntry): void {
    const timer = setTimeout(() => {
      if (this.pending.get(id) === entry) {
        this.pending.delete(id);
      }
    }, RESOLVED_ENTRY_GRACE_MS);
    unrefTimer(timer);
  }

  getSnapshot(id: string): QuestionRecord | null {
    return this.pending.get(id)?.record ?? null;
  }

  /** Lists pending records, optionally filtered by a visibility predicate. */
  list(filter?: (record: QuestionRecord) => boolean): QuestionRecord[] {
    return Array.from(this.pending.values())
      .map((entry) => entry.record)
      .filter((record) => record.status === "pending")
      .filter((record) => filter?.(record) ?? true);
  }
}

let globalQuestionManager: QuestionManager | null = null;

/**
 * Returns the process-global question manager. The asking tool and the gateway
 * resolve/list handlers share this single in-memory instance so a promise can park
 * the tool while any surface answers.
 */
export function getGlobalQuestionManager(): QuestionManager {
  if (!globalQuestionManager) {
    globalQuestionManager = new QuestionManager();
  }
  return globalQuestionManager;
}

/** Test-only reset so suites do not leak pending records across cases. */
export function resetGlobalQuestionManagerForTest(): void {
  globalQuestionManager = null;
}
