import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asNullableRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveAssistantMessagePhase } from "../../../../../src/shared/chat-message-content.js";
import { t } from "../../../i18n/index.ts";
import type { ChatQueueItem } from "../../../lib/chat/chat-types.ts";
import type { DurableComposerDraftScope } from "../../../lib/chat/composer-draft-store.runtime.ts";
import { extractTextCached } from "../../../lib/chat/message-extract.ts";
import { shouldHideAssistantChatMessage } from "../../../lib/chat/message-visibility.ts";
import { showToast } from "../../../lib/toast.ts";
import {
  isKeyedAssistantStreamFallbackMessage,
  transcriptRunId,
} from "../chat-thread-run-identity.ts";
import { persistedSteerTargetRunId } from "../stream-causal-boundary.ts";
import {
  readLiveTerminalDisposition,
  readLiveTerminalRunId,
} from "../terminal-message-identity.ts";
import {
  persistAsyncQuestionDrafts,
  restoreAsyncQuestionDrafts,
  type AsyncQuestionDraftSession,
} from "./chat-async-question-draft.ts";
import { parseGeneratedAsyncAnswer, quoteQuestion } from "./chat-async-question-summary.ts";
import type {
  AsyncQuestionDraft,
  AsyncQuestionPresentation,
  AsyncQuestions,
} from "./chat-async-question.types.ts";
import { questionDraftValues } from "./chat-question-answer-controls.ts";
import type { QuestionPanelOptions, QuestionPanelProps } from "./chat-question-card.ts";

export { renderAsyncQuestionSummary } from "./chat-async-question-summary.ts";

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
        // A canonical reply identifies the question even when edited text or quoted
        // headings prevent splitting its answers. Unlinked duplicate titles stay ambiguous.
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
          .filter((match) => match.answers !== null || Boolean(replyToId && text.trim()));
        const match = matches.length === 1 ? matches[0] : undefined;
        if (match) {
          resolved.set(match.question.itemId, {
            status: "submitted",
            answers: match.answers ?? new Map(),
            ...(match.answers ? {} : { unparsedText: text }),
          });
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
    asyncQuestionGeneration?: number;
    asyncQuestionPresentation?: AsyncQuestionPresentation;
    asyncQuestionSessions?: Map<string, AsyncQuestionDraftSession>;
    asyncQuestionDrafts: Map<string, AsyncQuestionDraft>;
    asyncQuestionRevision: number;
    transcriptRenderContext: { onAsyncQuestionSubmit?: AsyncQuestionPresentation["submit"] };
  },
  props: {
    messages?: readonly unknown[];
    queue?: readonly ChatQueueItem[];
    onQueueRetry?: (id: string) => void;
    sessionKey: string;
    currentAgentId?: string;
    connectionEpoch?: number;
    asyncQuestionStorage?: DurableComposerDraftScope | null;
    onAsyncQuestionSubmit?: AsyncQuestionPresentation["submit"];
    onReopen?: (itemId: string, scope: string) => void;
    onRequestUpdate?: () => void;
  },
): AsyncQuestionPresentation {
  const storageScope = props.asyncQuestionStorage
    ? {
        ...props.asyncQuestionStorage,
        scopeKey: `questions:v1:${props.asyncQuestionStorage.scopeKey}`,
      }
    : undefined;
  const storageKey = storageScope
    ? JSON.stringify([storageScope.gatewayOwner, storageScope.recoveryScope, storageScope.scopeKey])
    : undefined;
  // Session navigation/reconnect can reuse drafts only within the same authenticated
  // owner. A direct non-null owner replacement must also retire old callbacks and
  // force a fresh read on return, so a cached map cannot bypass a deletion tombstone.
  for (const [key, cached] of state.asyncQuestionSessions ?? []) {
    if (
      storageScope &&
      cached.scope.gatewayOwner === storageScope.gatewayOwner &&
      cached.scope.recoveryScope === storageScope.recoveryScope
    ) {
      continue;
    }
    cached.invalidated = true;
    state.asyncQuestionSessions?.delete(key);
  }
  const scope = JSON.stringify([
    props.sessionKey,
    props.currentAgentId,
    props.connectionEpoch,
    storageKey,
  ]);
  let session: AsyncQuestionDraftSession | undefined;
  if (storageScope && storageKey) {
    const sessions = (state.asyncQuestionSessions ??= new Map());
    session = sessions.get(storageKey);
    if (!session) {
      session = {
        scope: storageScope,
        drafts: new Map(),
        resolved: new Set(),
        revision: 0,
        saved: "[]",
        loaded: false,
        onChange: () => {},
      };
      sessions.set(storageKey, session);
    }
  }
  if (
    state.asyncQuestionScope !== scope ||
    (session && state.asyncQuestionDrafts !== session.drafts)
  ) {
    state.asyncQuestionScope = scope;
    state.asyncQuestionGeneration = (state.asyncQuestionGeneration ?? 0) + 1;
    state.asyncQuestionDrafts = session?.drafts ?? new Map();
  }
  const drafts = state.asyncQuestionDrafts;
  const generation = state.asyncQuestionGeneration;
  const isCurrent = () =>
    state.asyncQuestionScope === scope &&
    state.asyncQuestionGeneration === generation &&
    state.asyncQuestionDrafts === drafts;
  const { history: questions, resolved } = questionHistory(props.messages ?? []);
  // This is a projection, never another sender: a recovered outbox row retains
  // the question association and is the only owner of retry and delivery state.
  const delivery = new Map(
    (props.queue ?? []).flatMap((item) =>
      item.asyncQuestionItemId ? [[item.asyncQuestionItemId, item] as const] : [],
    ),
  );
  const notify = () => {
    if (isCurrent()) {
      state.asyncQuestionRevision += 1;
      props.onRequestUpdate?.();
    }
  };
  if (session) {
    session.resolved = new Set(resolved.keys());
    session.onChange = notify;
    for (const { question } of questions) {
      getQuestionDraft(question, drafts);
    }
    restoreAsyncQuestionDrafts(session);
    // Resolving an answer from authoritative history retires its recoverable draft.
    if (session.loaded && resolved.size) {
      persistAsyncQuestionDrafts(session);
    }
  }
  const archived = new Map<string, string>();
  const pending = questions.flatMap(({ question, boundary }) => {
    const queued = delivery.get(question.itemId);
    if (queued && !resolved.has(question.itemId)) {
      // A recovered outbox already owns this answer. Remember its admission in
      // the local presentation even if ACK retires the row before history arrives.
      // This prevents reopening a second submit form; only history confirms Sent.
      const admitted = getQuestionDraft(question, drafts);
      admitted.status = "submitted";
      admitted.admittedQueueId = queued.id;
      admitted.answers = parseGeneratedAsyncAnswer(question, queued.text) ?? admitted.answers;
    }
    const draft = resolved.get(question.itemId) ?? drafts.get(question.itemId);
    if (delivery.has(question.itemId) || draft?.status === "submitted") {
      return [];
    }
    if (draft?.status === "skipped" || draft?.status === "reopening") {
      // Keep the current completion boundary available while a durable Undo waits.
      if (boundary) {
        archived.set(question.itemId, boundary);
      }
      return [];
    }
    if (
      boundary &&
      !draft?.edited &&
      !draft?.status &&
      !draft?.error &&
      draft?.reopenedAfterBoundary !== boundary
    ) {
      archived.set(question.itemId, boundary);
      return [];
    }
    return [question];
  });
  const onChange = () => {
    if (isCurrent()) {
      if (session) {
        persistAsyncQuestionDrafts(session, true);
      }
      notify();
    }
  };
  const storageError = () =>
    session?.error
      ? t(
          session.error === "conflict"
            ? "chat.asyncQuestions.draftConflict"
            : "chat.asyncQuestions.draftStorageFailed",
        )
      : undefined;
  const reopen = async (itemId: string) => {
    const entry = questions.find(({ question }) => question.itemId === itemId);
    const draft = drafts.get(itemId);
    if (
      isCurrent() &&
      entry &&
      !resolved.has(itemId) &&
      !state.asyncQuestionPresentation?.resolved.has(itemId) &&
      draft?.status !== "reopening" &&
      (archived.has(itemId) || draft?.status === "skipped")
    ) {
      const current = getQuestionDraft(entry.question, drafts);
      const durableDismissal = current.status === "skipped" && session;
      current.status = durableDismissal ? "reopening" : undefined;
      current.error = undefined;
      current.reopenedAfterBoundary = entry.boundary;
      if (durableDismissal) {
        // Do not present Undo/Answer as restored while reload still reads dismissed.
        // The existing writer serializes this intent behind any dismissal in flight.
        for (;;) {
          onChange();
          await durableDismissal.write;
          const latest = state.asyncQuestionPresentation;
          if (drafts.get(itemId) !== current || current.status !== "reopening") {
            return;
          }
          if (!isCurrent() || latest?.resolved.has(itemId)) {
            current.status = undefined;
            durableDismissal.onChange();
            return;
          }
          const boundary = latest?.archived.get(itemId);
          if (current.reopenedAfterBoundary === boundary) {
            break;
          }
          // History can advance during the save; persist that latest reopen boundary
          // before revealing an untouched answer that would otherwise age out again.
          current.reopenedAfterBoundary = boundary;
        }
        current.status = undefined;
      }
      // Failed storage still permits answering, with the existing unsaved notice.
      props.onReopen?.(itemId, scope);
      onChange();
    }
  };
  const presentation: AsyncQuestionPresentation = {
    scope,
    pending,
    archived,
    historyKey: JSON.stringify([
      [...archived],
      [...resolved].map(([itemId, draft]) => [
        itemId,
        draft.unparsedText,
        [...draft.answers].map(([questionId, answer]) => [questionId, questionDraftValues(answer)]),
      ]),
      [...delivery].map(([itemId, item]) => [
        itemId,
        item.id,
        item.text,
        item.sendState,
        item.sendError,
      ]),
      Boolean(props.onAsyncQuestionSubmit && props.onQueueRetry),
    ]),
    drafts,
    resolved,
    delivery,
    discard: (item) => {
      if (!isCurrent()) {
        return;
      }
      const itemId = item.asyncQuestionItemId;
      const draft = itemId ? drafts.get(itemId) : undefined;
      if (!itemId || draft?.admittedQueueId !== item.id || resolved.has(itemId)) {
        return;
      }
      // Only the outbox owner's successful explicit removal retires admission.
      // Replace the draft so a late completion cannot mark it submitted again.
      drafts.set(itemId, {
        ...draft,
        status: undefined,
        admittedQueueId: undefined,
        error: undefined,
        reopenedAfterBoundary: questions.find(({ question }) => question.itemId === itemId)
          ?.boundary,
      });
      onChange();
    },
    retry:
      props.onAsyncQuestionSubmit && props.onQueueRetry
        ? (id) => {
            if (isCurrent() && state.transcriptRenderContext.onAsyncQuestionSubmit) {
              props.onQueueRetry?.(id);
            }
          }
        : undefined,
    storageError: storageError(),
    onChange,
    reopen,
    dismiss: async (itemId) => {
      const question = questions.find((entry) => entry.question.itemId === itemId)?.question;
      if (!isCurrent() || !question || resolved.has(itemId)) {
        return;
      }
      const draft = getQuestionDraft(question, drafts);
      if (draft.status) {
        return;
      }
      draft.status = "skipped";
      draft.error = undefined;
      onChange();
      await session?.write;
      const current = state.asyncQuestionPresentation;
      if (
        isCurrent() &&
        current?.drafts.get(itemId) === draft &&
        draft.status === "skipped" &&
        !current.resolved.has(itemId)
      ) {
        showToast({
          message: storageError() ?? t("chat.asyncQuestions.dismissedNotice"),
          actionLabel: t("common.undo"),
          // History can advance while the toast remains visible. The latest
          // projection owns both canonical resolution and the reopen boundary.
          onAction: () => {
            if (isCurrent()) {
              void state.asyncQuestionPresentation?.reopen(itemId);
            }
          },
        });
      }
    },
    submit: props.onAsyncQuestionSubmit
      ? async (message, itemId, sourceMessageId) => {
          if (!isCurrent()) {
            return false;
          }
          return (
            (await state.transcriptRenderContext.onAsyncQuestionSubmit?.(
              message,
              itemId,
              sourceMessageId,
            )) === true
          );
        }
      : undefined,
  };
  state.asyncQuestionPresentation = presentation;
  return presentation;
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

function getQuestionDraft(questions: AsyncQuestions, drafts: Map<string, AsyncQuestionDraft>) {
  let draft = drafts.get(questions.itemId);
  const signature = JSON.stringify(questions.questions);
  if (!draft || (draft.signature && draft.signature !== signature)) {
    draft = {
      signature,
      answers: new Map(
        questions.questions.map((question, index) => [
          String(index),
          { selected: new Set(question.options?.slice(0, 1)), freeText: "" },
        ]),
      ),
    };
    drafts.set(questions.itemId, draft);
  }
  draft.signature = signature;
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
      notice: presentation.storageError,
      requestPosition: options.requestPosition,
    },
    onChange: () => {
      draft.edited = true;
      presentation.onChange();
    },
    onCollapsedChange: options.onCollapsedChange,
    onPreviousRequest: options.onPreviousRequest,
    onNextRequest: options.onNextRequest,
    onSkip: () => presentation.dismiss(questions.itemId),
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
        if (!(await presentation.submit?.(message, questions.itemId, questions.sourceMessageId))) {
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
