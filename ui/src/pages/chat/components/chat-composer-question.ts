import { html, nothing } from "lit";
import { createAsyncQuestionPanelProps } from "./chat-async-question.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";
import {
  createGatewayQuestionPanelProps,
  type QuestionPanelOptions,
  type QuestionPanelProps,
} from "./chat-question-card.ts";

export function renderComposerQuestionDock(panel: QuestionPanelProps | null) {
  return panel
    ? html`<div class="agent-chat__question-dock">
        <openclaw-chat-question-panel .props=${panel}></openclaw-chat-question-panel>
      </div>`
    : nothing;
}

export function resolveComposerQuestionPanel(
  props: ChatComposerProps,
  state: ChatComposerState,
  requestUpdate: () => void,
): QuestionPanelProps | null {
  const gatewayQuestions =
    props.gatewayQuestionPrompts?.filter((prompt) => prompt.status === "pending") ?? [];
  const asyncQuestions = props.asyncQuestions;
  const asyncQuestionIdentity = (itemId: string) =>
    JSON.stringify([props.sessionKey, props.currentAgentId, itemId]);
  const requests =
    props.disabledBanner?.kind === "composer-replacement"
      ? []
      : [
          ...gatewayQuestions.map((prompt) => ({
            key: `gateway:${prompt.id}`,
            asyncIdentity: null,
            compactOnArrival: false,
            panel: (options: QuestionPanelOptions) =>
              createGatewayQuestionPanelProps(prompt, {
                ...options,
                onChange: props.onGatewayQuestionChange,
                onSubmit: props.onGatewayQuestionSubmit
                  ? (answers) => props.onGatewayQuestionSubmit?.(prompt.id, answers)
                  : undefined,
                onSkip: props.onGatewayQuestionSkip
                  ? () => props.onGatewayQuestionSkip?.(prompt.id)
                  : undefined,
              }),
          })),
          ...(asyncQuestions?.submit
            ? asyncQuestions.pending.map((question) => ({
                key: JSON.stringify([asyncQuestions.scope, question.itemId]),
                asyncIdentity: asyncQuestionIdentity(question.itemId),
                compactOnArrival: !state.asyncQuestionIds.has(
                  asyncQuestionIdentity(question.itemId),
                ),
                panel: (options: QuestionPanelOptions) =>
                  createAsyncQuestionPanelProps(question, asyncQuestions, options),
              }))
            : []),
        ];
  // Arrival belongs to presentation, not whether persistence has initialized a draft.
  // The identity stays stable across reconnects so editing does not close the card.
  state.asyncQuestionIds = new Set(
    asyncQuestions?.pending
      .map((question) => asyncQuestionIdentity(question.itemId))
      .filter((identity) => state.asyncQuestionIds.has(identity)),
  );
  // A newly arrived blocking request takes priority, but navigation can still
  // reach async questions without repeatedly switching back on every render.
  const newGatewayQuestion = gatewayQuestions.find(
    (prompt) => !state.gatewayQuestionIds.has(prompt.id),
  );
  state.gatewayQuestionIds = new Set(gatewayQuestions.map((prompt) => prompt.id));
  const activeGatewayQuestion = gatewayQuestions.some(
    (prompt) => state.activeQuestionKey === `gateway:${prompt.id}`,
  );
  if (newGatewayQuestion && !activeGatewayQuestion) {
    state.activeQuestionKey = `gateway:${newGatewayQuestion.id}`;
    state.questionCollapsed = false;
  }
  let index = requests.findIndex((request) => request.key === state.activeQuestionKey);
  if (index < 0) {
    index = 0;
    state.activeQuestionKey = requests[0]?.key ?? null;
    const nextRequest = requests[index];
    // A new optional prompt must not interrupt an in-progress composer draft.
    // Reconnect/storage scope changes do not change a seen optional disclosure.
    // A required question still opens when it replaces the active request.
    // A temporary capability gap has no replacement and keeps the disclosure.
    if (nextRequest) {
      state.questionCollapsed =
        nextRequest.asyncIdentity === null
          ? false
          : nextRequest.compactOnArrival
            ? Boolean(props.draft.trim()) ||
              (state.composerTextarea !== null && document.activeElement === state.composerTextarea)
            : state.questionCollapsed;
    }
  }
  const request = requests[index];
  if (!request) {
    return null;
  }
  // A queued question has not arrived in the dock until it becomes active.
  if (request.asyncIdentity !== null) {
    state.asyncQuestionIds.add(request.asyncIdentity);
  }
  const selectRequest = (next: number) => {
    state.activeQuestionKey = requests[next]!.key;
    state.questionCollapsed = false;
    requestUpdate();
  };
  return request.panel({
    collapsed: state.questionCollapsed,
    onCollapsedChange: (collapsed) => {
      state.questionCollapsed = collapsed;
      state.restoreComposerFocus = collapsed;
      requestUpdate();
      if (collapsed) {
        queueMicrotask(() => {
          if (state.restoreComposerFocus && state.composerTextarea?.isConnected) {
            state.restoreComposerFocus = false;
            state.composerTextarea.focus({ preventScroll: true });
          }
        });
      }
    },
    requestPosition:
      requests.length > 1 ? { current: index + 1, total: requests.length } : undefined,
    onPreviousRequest: () => selectRequest((index - 1 + requests.length) % requests.length),
    onNextRequest: () => selectRequest((index + 1) % requests.length),
  });
}
