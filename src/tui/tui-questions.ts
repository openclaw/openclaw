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
  const pending = new Map<string, QuestionRecord>();
  const collapsed = new Set<string>();
  const drafts = new Map<string, QuestionPrompt>();
  const resolving = new Set<string>();
  const unconfirmed = new Map<string, QuestionRecord>();
  const checking = new Map<string, Promise<"pending" | "terminal" | "unknown">>();
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

  function remove(id: string) {
    pending.delete(id);
    unconfirmed.delete(id);
    collapsed.delete(id);
    drafts.get(id)?.dispose();
    drafts.delete(id);
    remember(id, null);
    if (active?.id === id) {
      closeActive();
    }
  }

  function finish(id: string, status: Exclude<QuestionStatus, "pending">) {
    const record = pending.get(id);
    remove(id);
    if (record && matchesSession(record)) {
      deps.chatLog.addSystem(`Question: ${status === "cancelled" ? "skipped" : status}.`);
    }
  }

  function abandon(record: QuestionRecord) {
    if (!pending.has(record.id)) {
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
    if (disposed || !unconfirmed.has(record.id)) {
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
      if (disposed || !unconfirmed.has(record.id)) {
        return "terminal";
      }
      if (!Value.Check(QuestionGetResultSchema, result) || result.question.id !== record.id) {
        return "unknown";
      }
      if (result.question.status !== "pending") {
        finish(record.id, result.question.status);
        return "terminal";
      }
      unconfirmed.delete(record.id);
      pending.set(record.id, result.question);
      remember(record.id, result.question);
      return "pending";
    } catch (error) {
      if (disposed || !unconfirmed.has(record.id)) {
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
    const current = checking.get(record.id);
    if (current) {
      return current;
    }
    const recovery = recoverOnce(record);
    checking.set(record.id, recovery);
    try {
      return await recovery;
    } finally {
      if (checking.get(record.id) === recovery) {
        checking.delete(record.id);
      }
    }
  }

  function updatePendingText(records: QuestionRecord[]) {
    const record = records[0];
    const text = records.some((question) => unconfirmed.has(question.id))
      ? "Answer confirmation unavailable · /question to check"
      : record
        ? `Question pending${records.length > 1 ? ` (${records.length})` : ""} · ${Math.max(0, Math.ceil((record.expiresAtMs - Date.now()) / 1_000))}s · /question to open`
        : "";
    if (text !== pendingText) {
      pendingText = text;
      deps.onPendingChange(text);
    }
  }

  function present() {
    if (disposed) {
      return;
    }
    clearTimeout(timer);
    timer = undefined;
    const now = Date.now();
    for (const record of pending.values()) {
      if (record.expiresAtMs <= now) {
        if (unconfirmed.has(record.id)) {
          abandon(record);
        } else if (!resolving.has(record.id)) {
          finish(record.id, "expired");
        }
      }
    }
    const records = [...pending.values()]
      .filter(matchesSession)
      .toSorted((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id));
    if (active && !records.some((record) => record.id === active?.id)) {
      closeActive();
    }
    const record = records.find(
      (entry) => !collapsed.has(entry.id) && !resolving.has(entry.id) && !unconfirmed.has(entry.id),
    );
    if (!active && record) {
      let prompt = drafts.get(record.id);
      if (!prompt) {
        prompt = new QuestionPrompt(record, {
          onSubmit: (answers) =>
            void resolve(record, { id: record.id, answers, resolutionId: randomUUID() }),
          onSkip: () => void resolve(record, { id: record.id, cancel: true }),
          onCollapse: () => {
            if (active?.id !== record.id) {
              return;
            }
            for (const question of pending.values()) {
              if (matchesSession(question)) {
                collapsed.add(question.id);
              }
            }
            closeActive();
            present();
          },
          requestRender: deps.requestRender,
        });
        drafts.set(record.id, prompt);
      }
      active = { id: record.id, handle: deps.openOverlay(prompt, { width: "100%" }) };
    }
    updatePendingText(records);
    const expiring = [...pending.values()].filter((entry) => !resolving.has(entry.id));
    if (expiring.length > 0) {
      const expiry = Math.min(...expiring.map((entry) => entry.expiresAtMs));
      timer = setTimeout(present, Math.max(1, Math.min(1_000, expiry - now)));
      timer.unref?.();
    }
    deps.requestRender();
  }

  async function resolve(record: QuestionRecord, params: QuestionResolveParams) {
    if (disposed || active?.id !== record.id || resolving.has(record.id)) {
      return;
    }
    if (record.expiresAtMs <= Date.now()) {
      finish(record.id, "expired");
      present();
      return;
    }
    resolving.add(record.id);
    closeActive();
    drafts.get(record.id)?.dispose();
    drafts.delete(record.id);
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
      if (!disposed && pending.has(record.id)) {
        collapsed.add(record.id);
        unconfirmed.set(record.id, record);
        const outcome = await recover(record);
        if (!disposed && pending.has(record.id) && matchesSession(record)) {
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
      resolving.delete(record.id);
      present();
    }
  }

  async function refreshOnce(): Promise<void> {
    if (disposed) {
      return;
    }
    const startedAtVersion = mutationVersion;
    await Promise.all([...unconfirmed.values()].map(recover));
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
    for (const id of pending.keys()) {
      if (!next.has(id) && !unconfirmed.has(id) && !resolving.has(id)) {
        remove(id);
      }
    }
    for (const [id, question] of next) {
      pending.set(id, question);
    }
    present();
  }

  async function refresh(): Promise<void> {
    if (!disposed) {
      await refreshRunner.run();
    }
  }

  return {
    handleEvent(event: string, payload: unknown) {
      if (disposed) {
        return;
      }
      if (event === "question.requested" && Value.Check(QuestionRecordSchema, payload)) {
        if (payload.status === "pending") {
          pending.set(payload.id, payload);
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
      for (const record of pending.values()) {
        if (matchesSession(record) && !unconfirmed.has(record.id)) {
          collapsed.delete(record.id);
        }
      }
      present();
      if (!disposed && ![...pending.values()].some(matchesSession)) {
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
      for (const prompt of drafts.values()) {
        prompt.dispose();
      }
      drafts.clear();
      pending.clear();
      collapsed.clear();
      resolving.clear();
      unconfirmed.clear();
      checking.clear();
      mutations.clear();
      deps.onPendingChange("");
      deps.requestRender();
    },
  };
}
