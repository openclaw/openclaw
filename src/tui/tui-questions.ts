import { randomUUID } from "node:crypto";
// Questions use the same session-scoped controller in Gateway and embedded TUI modes.
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import {
  QuestionGetResultSchema,
  QuestionListResultSchema,
  QuestionRecordSchema,
  QuestionResolvedEventSchema,
  QuestionResolveResultSchema,
  type QuestionRecord,
  type QuestionResolveParams,
  type QuestionStatus,
} from "@openclaw/gateway-protocol";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import { createTuiRefreshCoalescer } from "./coalesced-refresh.js";
import { QuestionPrompt } from "./components/question-prompt.js";
import type { TuiBackend } from "./tui-backend.js";
import { matchesOwnedTuiSession } from "./tui-session-events.js";

type TuiQuestionControllerDeps = {
  client: Pick<TuiBackend, "listQuestions" | "getQuestion" | "resolveQuestion">;
  chatLog: { addSystem: (line: string) => void };
  getAgentId: () => string;
  getSessionKey: () => string;
  openOverlay: TUI["showOverlay"];
  closeOverlay: (handle?: OverlayHandle) => void;
  requestRender: () => void;
  onPendingChange: (text: string) => void;
};
type QuestionState = {
  record?: QuestionRecord;
  collapsed?: boolean;
  prompt?: QuestionPrompt;
  resolving?: boolean;
  unconfirmed?: QuestionRecord;
  recovery?: Promise<"pending" | "terminal" | "unknown">;
};
type QuestionMutation = { version: number; question: QuestionRecord | null };

function isSecretStoreRefreshFailure(record: QuestionRecord, error: unknown): boolean {
  return (
    record.questions.some((question) => question.secretStore !== undefined) &&
    error instanceof Error &&
    asOptionalObjectRecord(error)?.gatewayCode === "UNAVAILABLE" &&
    error.message.startsWith("Secret store entry was saved, but runtime refresh failed.")
  );
}

export function createTuiQuestionController(deps: TuiQuestionControllerDeps) {
  const questions = new Map<string, QuestionState>();
  const mutations = new Map<string, QuestionMutation>();
  let mutationVersion = 0;
  let active: { id: string; handle: OverlayHandle } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let pendingText = "";
  const refreshRunner = createTuiRefreshCoalescer(refreshOnce, () => mutations.clear());

  const matchesSession = (record: QuestionRecord) =>
    matchesOwnedTuiSession(deps.getSessionKey(), deps.getAgentId(), record);

  function closeActive() {
    if (active) {
      const handle = active.handle;
      active = null;
      deps.closeOverlay(handle);
    }
  }

  function remember(id: string, question: QuestionRecord | null) {
    if (refreshRunner.isRunning()) {
      mutations.set(id, { version: ++mutationVersion, question });
    }
  }

  const questionRecords = (field: "record" | "unconfirmed" = "record") =>
    [...questions.values()].flatMap((state) => {
      const record = state[field];
      return record ? [record] : [];
    });

  function update(id: string, patch: QuestionState) {
    const state = { ...questions.get(id), ...patch };
    // Resolved events can precede RPC completion; keep its admission/recovery locks.
    if (!disposed && (state.record || state.resolving || state.recovery)) {
      questions.set(id, state);
    } else {
      questions.delete(id);
    }
  }

  function remove(id: string) {
    const state = questions.get(id);
    state?.prompt?.dispose();
    questions.delete(id);
    update(id, { resolving: state?.resolving, recovery: state?.recovery });
    remember(id, null);
    if (active?.id === id) {
      closeActive();
    }
    return state?.record;
  }

  function finish(id: string, status: Exclude<QuestionStatus, "pending">) {
    const record = remove(id);
    if (record && matchesSession(record)) {
      deps.chatLog.addSystem(`Question: ${status === "cancelled" ? "skipped" : status}.`);
    }
  }

  function abandon(record: QuestionRecord) {
    if (!questions.get(record.id)?.record) {
      return;
    }
    remove(record.id);
    if (matchesSession(record)) {
      deps.chatLog.addSystem(
        "Question outcome could not be recovered; check the conversation or secret store before requesting again.",
      );
    }
  }

  async function recoverOnce(record: QuestionRecord): Promise<"pending" | "terminal" | "unknown"> {
    if (disposed || !questions.get(record.id)?.unconfirmed) {
      return "terminal";
    }
    if (record.expiresAtMs <= Date.now()) {
      abandon(record);
      return "terminal";
    }
    if (!deps.client.getQuestion) {
      return "unknown";
    }
    try {
      const result = await deps.client.getQuestion(record.id);
      if (disposed || !questions.get(record.id)?.unconfirmed) {
        return "terminal";
      }
      if (!Value.Check(QuestionGetResultSchema, result) || result.question.id !== record.id) {
        return "unknown";
      }
      if (result.question.status !== "pending") {
        finish(record.id, result.question.status);
        return "terminal";
      }
      update(record.id, { record: result.question, unconfirmed: undefined });
      remember(record.id, result.question);
      return "pending";
    } catch (error) {
      if (disposed || !questions.get(record.id)?.unconfirmed) {
        return "terminal";
      }
      const errorRecord = asOptionalObjectRecord(error);
      const reason = asOptionalObjectRecord(errorRecord?.details)?.reason;
      if (reason === "QUESTION_NOT_FOUND" || errorRecord?.code === "QUESTION_NOT_FOUND") {
        abandon(record);
        return "terminal";
      }
      return "unknown";
    }
  }

  async function recover(record: QuestionRecord) {
    const current = questions.get(record.id)?.recovery;
    if (current) {
      return current;
    }
    const recovery = recoverOnce(record);
    update(record.id, { recovery });
    try {
      return await recovery;
    } finally {
      if (questions.get(record.id)?.recovery === recovery) {
        update(record.id, { recovery: undefined });
      }
    }
  }

  function present() {
    if (disposed) {
      return;
    }
    clearTimeout(timer);
    timer = undefined;
    const now = Date.now();
    for (const record of questionRecords()) {
      if (record.expiresAtMs <= now) {
        if (questions.get(record.id)?.unconfirmed) {
          abandon(record);
        } else if (!questions.get(record.id)?.resolving) {
          finish(record.id, "expired");
        }
      }
    }
    const records = questionRecords()
      .filter(matchesSession)
      .toSorted((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id));
    if (active && !records.some((record) => record.id === active?.id)) {
      closeActive();
    }
    const record = records.find(({ id }) => {
      const state = questions.get(id);
      return !state?.collapsed && !state?.resolving && !state?.unconfirmed;
    });
    if (!active && record) {
      const prompt =
        questions.get(record.id)?.prompt ??
        new QuestionPrompt(record, {
          onSubmit: (answers) =>
            void resolve(record, { id: record.id, answers, resolutionId: randomUUID() }),
          onSkip: () => void resolve(record, { id: record.id, cancel: true }),
          onCollapse: () => {
            if (active?.id !== record.id) {
              return;
            }
            for (const question of questionRecords()) {
              if (matchesSession(question)) {
                update(question.id, { collapsed: true });
              }
            }
            closeActive();
            present();
          },
          requestRender: deps.requestRender,
        });
      update(record.id, { prompt });
      active = { id: record.id, handle: deps.openOverlay(prompt, { width: "100%" }) };
    }
    const firstRecord = records[0];
    const text = records.some((question) => questions.get(question.id)?.unconfirmed)
      ? "Answer confirmation unavailable · /question to check"
      : firstRecord
        ? `Question pending${records.length > 1 ? ` (${records.length})` : ""} · ${Math.max(0, Math.ceil((firstRecord.expiresAtMs - Date.now()) / 1_000))}s · /question to open`
        : "";
    if (text !== pendingText) {
      pendingText = text;
      deps.onPendingChange(text);
    }
    const expiring = questionRecords().filter((entry) => !questions.get(entry.id)?.resolving);
    if (expiring.length > 0) {
      const expiry = Math.min(...expiring.map((entry) => entry.expiresAtMs));
      timer = setTimeout(present, Math.max(1, Math.min(1_000, expiry - now)));
      timer.unref?.();
    }
    deps.requestRender();
  }

  async function resolve(record: QuestionRecord, params: QuestionResolveParams) {
    if (disposed || active?.id !== record.id || questions.get(record.id)?.resolving) {
      return;
    }
    if (record.expiresAtMs <= Date.now()) {
      finish(record.id, "expired");
      present();
      return;
    }
    update(record.id, { resolving: true });
    closeActive();
    questions.get(record.id)?.prompt?.dispose();
    update(record.id, { prompt: undefined });
    present();
    try {
      if (!deps.client.resolveQuestion) {
        throw new Error("question resolution unavailable");
      }
      const result = await deps.client.resolveQuestion(params);
      if (!Value.Check(QuestionResolveResultSchema, result)) {
        throw new Error("invalid question resolution");
      }
      if (!disposed) {
        finish(record.id, result.status);
      }
    } catch (error) {
      // This Gateway error is emitted only after the store write commits; an
      // earlier resolved event must not hide its remaining runtime refresh failure.
      if (!disposed && isSecretStoreRefreshFailure(record, error)) {
        finish(record.id, "answered");
        if (matchesSession(record)) {
          deps.chatLog.addSystem(
            "Secret stored, but runtime refresh failed. Run openclaw secrets reload; do not resubmit this answer.",
          );
        }
        return;
      }
      // RPC errors may include submitted values. Never copy them into the terminal or chat.
      if (!disposed && questions.get(record.id)?.record) {
        update(record.id, { collapsed: true, unconfirmed: record });
        const outcome = await recover(record);
        if (!disposed && questions.get(record.id)?.record && matchesSession(record)) {
          if (outcome === "pending") {
            deps.chatLog.addSystem("Question is still pending. Use /question to retry.");
          } else if (outcome === "unknown") {
            deps.chatLog.addSystem(
              "Answer confirmation unavailable; use /question to check before retrying.",
            );
          }
        }
      }
    } finally {
      update(record.id, { resolving: undefined });
      present();
    }
  }

  async function refreshOnce(): Promise<void> {
    if (disposed) {
      return;
    }
    const startedAtVersion = mutationVersion;
    await Promise.all(questionRecords("unconfirmed").map(recover));
    if (disposed || !deps.client.listQuestions) {
      present();
      return;
    }
    const result = await deps.client.listQuestions();
    if (disposed) {
      return;
    }
    if (!Value.Check(QuestionListResultSchema, result)) {
      throw new Error("invalid question list");
    }
    const next = new Map(
      result.questions
        .filter((question) => question.status === "pending")
        .map((question) => [question.id, question]),
    );
    // The list snapshot predates any events received during its request.
    for (const [id, mutation] of mutations) {
      if (mutation.version > startedAtVersion) {
        if (mutation.question) {
          next.set(id, mutation.question);
        } else {
          next.delete(id);
        }
      }
    }
    for (const { id } of questionRecords()) {
      if (!next.has(id) && !questions.get(id)?.unconfirmed && !questions.get(id)?.resolving) {
        remove(id);
      }
    }
    for (const [id, question] of next) {
      update(id, { record: question });
    }
    present();
  }

  async function refresh(): Promise<void> {
    return disposed ? undefined : await refreshRunner.run();
  }

  return {
    handleEvent(event: string, payload: unknown) {
      if (disposed) {
        return;
      }
      if (event === "question.requested" && Value.Check(QuestionRecordSchema, payload)) {
        if (payload.status === "pending") {
          update(payload.id, { record: payload });
          remember(payload.id, payload);
          present();
        }
      } else if (
        event === "question.resolved" &&
        Value.Check(QuestionResolvedEventSchema, payload)
      ) {
        finish(payload.id, payload.status);
        present();
      }
    },
    refresh,
    sessionChanged() {
      present();
      return refresh();
    },
    async reopen() {
      if (disposed) {
        return;
      }
      await refresh();
      for (const record of questionRecords()) {
        if (matchesSession(record) && !questions.get(record.id)?.unconfirmed) {
          update(record.id, { collapsed: undefined });
        }
      }
      present();
      if (!disposed && !questionRecords().some(matchesSession)) {
        deps.chatLog.addSystem("No pending question for this session.");
        deps.requestRender();
      }
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      clearTimeout(timer);
      closeActive();
      for (const { prompt } of questions.values()) {
        prompt?.dispose();
      }
      questions.clear();
      mutations.clear();
      deps.onPendingChange("");
      deps.requestRender();
    },
  };
}
