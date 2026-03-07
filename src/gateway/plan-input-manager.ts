import { randomUUID } from "node:crypto";

const RESOLVED_ENTRY_GRACE_MS = 15_000;
export const DEFAULT_PLAN_INPUT_TIMEOUT_MS = 10 * 60_000;

export type PlanInputOption = {
  label: string;
  description: string;
};

export type PlanInputQuestion = {
  header: string;
  id: string;
  question: string;
  options: PlanInputOption[];
};

export type PlanInputAnswer = {
  answer: string;
  source: "option" | "other";
  optionIndex?: number;
};

export type PlanInputResult = {
  status: "answered" | "cancelled" | "expired";
  answers?: Record<string, PlanInputAnswer>;
};

export type PlanInputPrompt = {
  id: string;
  runId: string;
  sessionKey: string;
  questions: PlanInputQuestion[];
  createdAtMs: number;
  expiresAtMs: number;
  requestedByConnId?: string | null;
  requestedByDeviceId?: string | null;
  requestedByClientId?: string | null;
  resolvedAtMs?: number;
  result?: PlanInputResult;
  resolvedBy?: string | null;
};

type PendingEntry = {
  prompt: PlanInputPrompt;
  resolve: (result: PlanInputResult) => void;
  timer: ReturnType<typeof setTimeout>;
  promise: Promise<PlanInputResult>;
};

export class PlanInputManager {
  private pending = new Map<string, PendingEntry>();
  private promptIdByRunId = new Map<string, string>();

  create(params: {
    runId: string;
    sessionKey: string;
    questions: PlanInputQuestion[];
    timeoutMs?: number;
    id?: string | null;
  }): PlanInputPrompt {
    const now = Date.now();
    const timeoutMs = params.timeoutMs ?? DEFAULT_PLAN_INPUT_TIMEOUT_MS;
    return {
      id: params.id && params.id.trim() ? params.id.trim() : randomUUID(),
      runId: params.runId,
      sessionKey: params.sessionKey,
      questions: params.questions,
      createdAtMs: now,
      expiresAtMs: now + timeoutMs,
    };
  }

  register(prompt: PlanInputPrompt): Promise<PlanInputResult> {
    const existingById = this.pending.get(prompt.id);
    if (existingById) {
      if (existingById.prompt.resolvedAtMs === undefined) {
        return existingById.promise;
      }
      throw new Error(`plan input id '${prompt.id}' already resolved`);
    }
    const activePromptId = this.promptIdByRunId.get(prompt.runId);
    if (activePromptId) {
      const activeEntry = this.pending.get(activePromptId);
      if (activeEntry && activeEntry.prompt.resolvedAtMs === undefined) {
        throw new Error(`run '${prompt.runId}' already has a pending plan input request`);
      }
    }

    let resolvePromise: (result: PlanInputResult) => void;
    const promise = new Promise<PlanInputResult>((resolve) => {
      resolvePromise = resolve;
    });
    const entry: PendingEntry = {
      prompt,
      resolve: resolvePromise!,
      timer: null as unknown as ReturnType<typeof setTimeout>,
      promise,
    };
    entry.timer = setTimeout(() => {
      this.resolve(prompt.id, { status: "expired" }, null);
    }, Math.max(1, prompt.expiresAtMs - prompt.createdAtMs));
    this.pending.set(prompt.id, entry);
    this.promptIdByRunId.set(prompt.runId, prompt.id);
    return promise;
  }

  getSnapshot(id: string): PlanInputPrompt | null {
    return this.pending.get(id)?.prompt ?? null;
  }

  resolve(id: string, result: PlanInputResult, resolvedBy?: string | null): boolean {
    const entry = this.pending.get(id);
    if (!entry || entry.prompt.resolvedAtMs !== undefined) {
      return false;
    }
    clearTimeout(entry.timer);
    entry.prompt.resolvedAtMs = Date.now();
    entry.prompt.result = result;
    entry.prompt.resolvedBy = resolvedBy ?? null;
    this.promptIdByRunId.delete(entry.prompt.runId);
    entry.resolve(result);
    setTimeout(() => {
      if (this.pending.get(id) === entry) {
        this.pending.delete(id);
      }
    }, RESOLVED_ENTRY_GRACE_MS);
    return true;
  }
}
