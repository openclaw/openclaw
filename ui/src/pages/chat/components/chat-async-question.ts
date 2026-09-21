import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asNullableRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import { resolveAssistantMessagePhase } from "../../../../../src/shared/chat-message-content.js";
import type { QuestionDraft } from "../../../app/question-prompt.ts";
import { t } from "../../../i18n/index.ts";
import { extractTextCached } from "../../../lib/chat/message-extract.ts";
import { shouldHideAssistantChatMessage } from "../../../lib/chat/message-visibility.ts";
import {
  isKeyedAssistantStreamFallbackMessage,
  transcriptRunId,
} from "../chat-thread-run-identity.ts";
import { persistedSteerTargetRunId } from "../stream-causal-boundary.ts";
import {
  readLiveTerminalDisposition,
  readLiveTerminalRunId,
} from "../terminal-message-identity.ts";
import { questionDraftValues } from "./chat-question-answer-controls.ts";
import type { QuestionPanelOptions, QuestionPanelProps } from "./chat-question-card.ts";

export type AsyncQuestions = {
  itemId: string;
  sourceMessageId?: string;
  questions: { title: string; options?: string[] }[];
};

export type AsyncQuestionDraft = {
  answers: Map<string, QuestionDraft>;
  status?: "submitting" | "submitted" | "skipped";
  error?: string;
  reopenedAfterBoundary?: string;
};

export type AsyncQuestionPresentation = {
  scope: string;
  pending: AsyncQuestions[];
  archived: ReadonlyMap<string, string>;
  historyKey: string;
  drafts: Map<string, AsyncQuestionDraft>;
  resolved: ReadonlyMap<string, AsyncQuestionDraft>;
  onChange: () => void;
  reopen: (itemId: string) => void;
  submit?: (message: string) => Promise<boolean>;
};

function terminalOutcome(message: unknown): "successful" | "settled" | null {
  const record = asNullableRecord(message);
  const metadata = asNullableRecord(record?.["__openclaw"]);
  const phase = resolveAssistantMessagePhase(message);
  const stopReason = typeof record?.stopReason === "string" ? record.stopReason.toLowerCase() : "";
  if (
    record?.role !== "assistant" ||
    record.openclawAsyncDelivery ||
    isKeyedAssistantStreamFallbackMessage(message) ||
    asNullableRecord(record.provenance)?.kind === "inter_session" ||
    stopReason === "tooluse"
  ) {
    return null;
  }
  const failed =
    readLiveTerminalDisposition(message) !== null ||
    asNullableRecord(record.openclawAbort)?.aborted === true ||
    ["aborted", "cancelled", "canceled", "timeout", "timed_out", "error"].includes(stopReason);
  if (
    metadata?.runTerminal === true ||
    readLiveTerminalRunId(message) !== null ||
    (metadata?.mirrorOrigin !== "codex-app-server" &&
      (phase === "final_answer" || stopReason === "stop" || failed))
  ) {
    return failed || phase === "commentary" || shouldHideAssistantChatMessage(message)
      ? "settled"
      : "successful";
  }
  return null;
}

/** Reminders age out of the dock, not out of the conversation or the user's authority. */
function questionHistory(messages: readonly unknown[]) {
  const runs = new Map<string, { first: number; last: number; settled?: number }>();
  const userTurns = new Map<string, number>();
  const recoveryStarts = new Map<string, number>();
  const questions = new Map<
    string,
    { question: AsyncQuestions; index: number; runId?: string; originRunId?: string }
  >();
  const resolved = new Map<string, AsyncQuestionDraft>();
  const terminals: Array<{ index: number; turnStart: number; runId?: string; key: string }> = [];
  let turnStart = -1;
  let userRunId: string | undefined;
  for (const [index, message] of messages.entries()) {
    const record = asNullableRecord(message);
    const identity = readSessionMessageIdentity(message);
    const provenance = asNullableRecord(record?.provenance);
    const runId = transcriptRunId(message);
    if (
      identity?.role === "user" &&
      (!provenance?.kind || provenance.kind === "external_user") &&
      !persistedSteerTargetRunId(message)
    ) {
      turnStart = index;
      userRunId = runId;
      if (runId && !userTurns.has(runId)) {
        userTurns.set(runId, index);
      }
    }
    if (
      identity?.role === "user" &&
      identity.runId &&
      provenance?.kind === "internal_system" &&
      provenance.sourceTool === "main_session_restart_recovery"
    ) {
      recoveryStarts.set(identity.runId, index);
    }
    const outcome = terminalOutcome(message);
    if (runId) {
      const run = runs.get(runId);
      runs.set(runId, {
        first: run?.first ?? index,
        last: index,
        settled: outcome ? index : run?.settled,
      });
    }
    const question = readAsyncQuestions(message);
    if (question) {
      questions.set(question.itemId, { question, index, runId, originRunId: runId ?? userRunId });
    }
    if (
      identity?.role === "user" &&
      identity.id &&
      identity.sequence !== null &&
      !identity.isImported &&
      (!provenance?.kind || provenance.kind === "external_user")
    ) {
      const text = extractTextCached(message);
      if (text) {
        // Only canonical saved answers resolve a question; duplicate titles stay ambiguous.
        const rawReplyToId = asNullableRecord(record?.["__openclaw"])?.replyToId;
        const replyToId = typeof rawReplyToId === "string" ? rawReplyToId.trim() : "";
        const matches = [...questions.values()]
          .filter(
            ({ question: candidate }) =>
              !resolved.has(candidate.itemId) &&
              (!replyToId || candidate.sourceMessageId === replyToId),
          )
          .map(({ question: candidate }) => ({
            question: candidate,
            answers: parseGeneratedAsyncAnswer(candidate, text),
          }))
          .filter((match) => match.answers !== null);
        const match = matches.length === 1 ? matches[0] : undefined;
        if (match?.answers) {
          resolved.set(match.question.itemId, { status: "submitted", answers: match.answers });
        }
      }
    }
    if (outcome === "successful") {
      terminals.push({
        index,
        turnStart: runId ? (userTurns.get(runId) ?? -1) : turnStart,
        runId,
        key: JSON.stringify(
          runId
            ? ["run", runId]
            : [identity?.id, identity?.sequence, record?.timestamp, extractTextCached(message)],
        ),
      });
    }
  }
  // Index each successful completion against its own start, never the newest
  // user input. Known runs must have settled before a successor starts; a last
  // observed row alone does not prove an overlapping run has stopped.
  const laterRun = new Map<number, (typeof terminals)[number]>();
  const laterTurn = new Map<number, (typeof terminals)[number]>();
  const laterRecovery = new Map<number, (typeof terminals)[number]>();
  for (const terminal of terminals) {
    if (terminal.runId) {
      laterRun.set(runs.get(terminal.runId)!.first, terminal);
      const recoveryStart = recoveryStarts.get(terminal.runId);
      if (recoveryStart !== undefined && recoveryStart < terminal.index) {
        laterRecovery.set(recoveryStart, terminal);
      }
    }
    laterTurn.set(terminal.turnStart, terminal);
  }
  for (const lookup of [laterRun, laterTurn, laterRecovery]) {
    let latest: (typeof terminals)[number] | undefined;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const terminal = lookup.get(index);
      if (terminal && (!latest || terminal.index > latest.index)) {
        latest = terminal;
      }
      if (latest) {
        lookup.set(index, latest);
      }
    }
  }
  const history = [...questions.values()].map(({ question, index, runId, originRunId }) => {
    const origin = originRunId ? runs.get(originRunId) : undefined;
    const lookup = runId ? laterRun : laterTurn;
    let boundary = origin
      ? origin.settled !== undefined && origin.settled > index
        ? lookup.get(origin.last + 1)
        : undefined
      : lookup.get(index + 1);
    // Restart recovery records why an origin may have no terminal. Only its
    // matching successful completion retires older reminders; the marker alone
    // and unrelated internal inputs do not. Later successors also age reopens.
    const recovery = laterRecovery.get(index + 1);
    for (const candidate of [
      recovery,
      recovery ? laterRun.get(recovery.index + 1) : undefined,
      recovery ? laterTurn.get(recovery.index + 1) : undefined,
    ]) {
      if (candidate && (!boundary || candidate.index > boundary.index)) {
        boundary = candidate;
      }
    }
    return { question, boundary: boundary?.key };
  });
  return { history, resolved };
}

export function createAsyncQuestionPresentation(
  state: {
    asyncQuestionScope?: string;
    asyncQuestionDrafts: Map<string, AsyncQuestionDraft>;
    asyncQuestionRevision: number;
    transcriptRenderContext: { onAsyncQuestionSubmit?: AsyncQuestionPresentation["submit"] };
  },
  props: {
    messages?: readonly unknown[];
    sessionKey: string;
    currentAgentId?: string;
    connectionEpoch?: number;
    onAsyncQuestionSubmit?: AsyncQuestionPresentation["submit"];
    onReopen?: (itemId: string, scope: string) => void;
    onRequestUpdate?: () => void;
  },
): AsyncQuestionPresentation {
  const scope = JSON.stringify([props.sessionKey, props.currentAgentId, props.connectionEpoch]);
  if (state.asyncQuestionScope !== scope) {
    state.asyncQuestionScope = scope;
    state.asyncQuestionDrafts = new Map();
  }
  const drafts = state.asyncQuestionDrafts;
  const isCurrent = () =>
    state.asyncQuestionScope === scope && state.asyncQuestionDrafts === drafts;
  const { history: questions, resolved } = questionHistory(props.messages ?? []);
  const archived = new Map<string, string>();
  const pending = questions.flatMap(({ question, boundary }) => {
    const draft = resolved.get(question.itemId) ?? drafts.get(question.itemId);
    if (draft?.status === "submitted" || draft?.status === "skipped") {
      return [];
    }
    if (boundary && !draft?.status && !draft?.error && draft?.reopenedAfterBoundary !== boundary) {
      archived.set(question.itemId, boundary);
      return [];
    }
    return [question];
  });
  const onChange = () => {
    if (isCurrent()) {
      state.asyncQuestionRevision += 1;
      props.onRequestUpdate?.();
    }
  };
  return {
    scope,
    pending,
    archived,
    historyKey: JSON.stringify([
      [...archived],
      [...resolved].map(([itemId, draft]) => [
        itemId,
        [...draft.answers].map(([questionId, answer]) => [questionId, questionDraftValues(answer)]),
      ]),
    ]),
    drafts,
    resolved,
    onChange,
    reopen: (itemId) => {
      const boundary = archived.get(itemId);
      const question = questions.find((entry) => entry.question.itemId === itemId)?.question;
      if (isCurrent() && boundary && question) {
        const draft = getQuestionDraft(question, drafts);
        draft.reopenedAfterBoundary = boundary;
        props.onReopen?.(itemId, scope);
        onChange();
      }
    },
    submit: props.onAsyncQuestionSubmit
      ? async (message) => {
          if (!isCurrent()) {
            return false;
          }
          return (await state.transcriptRenderContext.onAsyncQuestionSubmit?.(message)) === true;
        }
      : undefined,
  };
}

function boundedText(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length <= limit && value.trim().length > 0;
}

export function readAsyncQuestions(message: unknown): AsyncQuestions | null {
  if (!isRecord(message) || message.role !== "assistant") {
    return null;
  }
  const metadata = message.openclawAsyncDelivery;
  if (
    !isRecord(metadata) ||
    !boundedText(metadata.itemId, 256) ||
    !Array.isArray(metadata.questions) ||
    metadata.questions.length === 0 ||
    metadata.questions.length > 12
  ) {
    return null;
  }
  const questions: AsyncQuestions["questions"] = [];
  for (const question of metadata.questions) {
    if (
      !isRecord(question) ||
      !boundedText(question.title, 4096) ||
      (question.options !== undefined &&
        (!Array.isArray(question.options) ||
          question.options.length === 0 ||
          question.options.length > 4 ||
          !question.options.every((option) => boundedText(option, 256))))
    ) {
      return null;
    }
    questions.push({ title: question.title, options: question.options });
  }
  const identity = readSessionMessageIdentity(message);
  const sourceMessageId =
    identity?.id && identity.sequence !== null && !identity.isImported ? identity.id : undefined;
  return { itemId: metadata.itemId, ...(sourceMessageId ? { sourceMessageId } : {}), questions };
}

function draftForAnswer(
  question: AsyncQuestions["questions"][number],
  answer: string,
): QuestionDraft {
  const values = answer ? answer.split(", ") : [];
  const selected =
    values.length > 0 &&
    values.every((value) => question.options?.includes(value)) &&
    values.join(", ") === answer
      ? new Set(values)
      : new Set<string>();
  return { selected, freeText: selected.size > 0 ? "" : answer };
}

function parseGeneratedAsyncAnswer(
  question: AsyncQuestions,
  message: string,
): Map<string, QuestionDraft> | null {
  let offset = 0;
  const answers: string[] = [];
  for (let index = 0; index < question.questions.length; index += 1) {
    const current = question.questions[index];
    if (!current) {
      return null;
    }
    const prefix = `${quoteQuestion(current.title)}\n\n`;
    if (!message.startsWith(prefix, offset)) {
      return null;
    }
    offset += prefix.length;
    if (index === question.questions.length - 1) {
      answers.push(message.slice(offset));
      offset = message.length;
      break;
    }
    const next = question.questions[index + 1];
    if (!next) {
      return null;
    }
    const separator = `\n\n${quoteQuestion(next.title)}\n\n`;
    const answerEnd = message.indexOf(separator, offset);
    // Free text can contain quoted headings. Do not guess a section boundary.
    if (answerEnd < offset || message.includes(separator, answerEnd + separator.length)) {
      return null;
    }
    answers.push(message.slice(offset, answerEnd));
    offset = answerEnd + 2;
  }
  if (
    offset !== message.length ||
    answers.length !== question.questions.length ||
    answers.some((answer) => !answer.trim())
  ) {
    return null;
  }
  return new Map(
    question.questions.map((entry, index) => [
      String(index),
      draftForAnswer(entry, answers[index] ?? ""),
    ]),
  );
}

function quoteQuestion(title: string): string {
  const encoder = new TextEncoder();
  let quote = "";
  let bytes = 0;
  for (const character of title) {
    bytes += encoder.encode(character).length;
    if (bytes > 512) {
      break;
    }
    quote += character;
  }
  return `> ${quote.replace(/[\r\n]/g, " ")}`;
}

function getQuestionDraft(questions: AsyncQuestions, drafts: Map<string, AsyncQuestionDraft>) {
  let draft = drafts.get(questions.itemId);
  if (!draft) {
    draft = {
      answers: new Map(
        questions.questions.map((question, index) => [
          String(index),
          { selected: new Set(question.options?.slice(0, 1)), freeText: "" },
        ]),
      ),
    };
    drafts.set(questions.itemId, draft);
  }
  return draft;
}

export function createAsyncQuestionPanelProps(
  questions: AsyncQuestions,
  presentation: AsyncQuestionPresentation,
  options: QuestionPanelOptions,
): QuestionPanelProps {
  const draft = getQuestionDraft(questions, presentation.drafts);
  const count = presentation.pending.reduce(
    (total, request) => total + request.questions.length,
    0,
  );
  return {
    model: {
      requestKey: JSON.stringify([presentation.scope, questions.itemId]),
      title: t("chat.asyncQuestions.title"),
      questions: questions.questions.map((question, index) => ({
        questionId: String(index),
        header: question.options ? question.title : t("chat.questions.answer"),
        question: question.title,
        options: (question.options ?? []).map((label) => ({ label })),
        isOther: true,
      })),
      autoFocus: false,
      nonBlocking: true,
      collapsed: options.collapsed ?? false,
      collapsedLabel: t(
        count === 1 ? "chat.asyncQuestions.pendingOne" : "chat.asyncQuestions.pendingMany",
        { count: String(count) },
      ),
      disabled: !presentation.submit,
      submitting: draft.status === "submitting",
      drafts: draft.answers,
      error: draft.error,
      requestPosition: options.requestPosition,
    },
    onChange: presentation.onChange,
    onCollapsedChange: options.onCollapsedChange,
    onPreviousRequest: options.onPreviousRequest,
    onNextRequest: options.onNextRequest,
    onSkip: () => {
      draft.status = "skipped";
      presentation.onChange();
    },
    onSubmit: async (answers: Record<string, string[]>) => {
      if (draft.status) {
        return;
      }
      draft.status = "submitting";
      draft.error = undefined;
      presentation.onChange();
      const message = questions.questions
        .map(
          (question, index) =>
            `${quoteQuestion(question.title)}\n\n${answers[String(index)]?.join(", ") ?? ""}`,
        )
        .join("\n\n");
      try {
        if (!(await presentation.submit?.(message))) {
          throw new Error(t("chat.asyncQuestions.sendFailed"));
        }
        draft.status = "submitted";
      } catch (error) {
        draft.status = undefined;
        draft.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        presentation.onChange();
      }
    },
  };
}

export function renderAsyncQuestionSummary(
  questions: AsyncQuestions,
  presentation: AsyncQuestionPresentation,
) {
  const draft =
    presentation.resolved.get(questions.itemId) ?? presentation.drafts.get(questions.itemId);
  const archived = presentation.archived.has(questions.itemId);
  return html`<div class="chat-question-summary" role="status">
    ${questions.questions.map(
      (question, index) => html`<div>
        <strong>${question.title}</strong>
        <div>
          ${
            draft?.status === "submitted"
              ? questionDraftValues(draft.answers.get(String(index))).join(", ")
              : t(
                  draft?.status === "skipped"
                    ? "chat.questions.skipped"
                    : archived
                      ? "chat.asyncQuestions.archived"
                      : "chat.asyncQuestions.inComposer",
                )
          }
        </div>
      </div>`,
    )}
    ${
      archived
        ? html`<div>${t("chat.asyncQuestions.archivedReason")}</div>
            <button
              type="button"
              class="btn btn--sm"
              @click=${() => presentation.reopen(questions.itemId)}
            >
              ${t("chat.questions.answer")}
            </button>`
        : nothing
    }
  </div>`;
}
