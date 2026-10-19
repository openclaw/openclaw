import { createEffect, createMemo, Show, untrack } from "solid-js";
import { createAsyncQuestionPanelProps } from "./chat-async-question.ts";
import { commitComposerDraft, composerDraftKey } from "./chat-composer-state.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";
import {
  createGatewayQuestionPanelProps,
  type QuestionPanelOptions,
  type QuestionPanelProps,
} from "./chat-question-card.ts";

export function ComposerQuestionDock(props: { panel: QuestionPanelProps | null }) {
  return (
    <Show when={props.panel}>
      <div class="agent-chat__question-dock">
        <openclaw-chat-question-card prop:props={props.panel ?? undefined} />
      </div>
    </Show>
  );
}

export function createComposerQuestionPanel(
  readProps: () => ChatComposerProps,
  state: ChatComposerState,
  readComposition?: () => { key: string; value: string } | null,
) {
  const source = createMemo(() => {
    const props = readProps();
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
                  panel: (options: QuestionPanelOptions) =>
                    createAsyncQuestionPanelProps(question, asyncQuestions, options),
                }))
              : []),
          ];
    return {
      requests,
      gatewayIds: gatewayQuestions.map((prompt) => prompt.id),
      asyncIds: asyncQuestions?.pending.map((question) => asyncQuestionIdentity(question.itemId)),
      draftKey: composerDraftKey(props),
      editing:
        Boolean(props.draft.trim()) ||
        (state.composerTextarea !== null && document.activeElement === state.composerTextarea),
    };
  });
  const syncTakeover = (active: boolean, draftKey: string) => {
    if (active && !state.questionTakeoverActive) {
      // Commit an interrupted IME draft before the store update unmounts its input.
      const composition = untrack(() => readComposition?.());
      if (state.composerComposing && composition?.key === draftKey) {
        // Sample the live draft owner without subscribing this imperative commit.
        untrack(() => commitComposerDraft(readProps(), composition.value));
      }
      state.composerComposing = false;
    }
    state.restoreComposerFocus ||= !active && state.questionTakeoverActive;
    state.questionTakeoverActive = active;
  };
  createEffect(source, (data) => {
    const { requests, gatewayIds, asyncIds, editing } = data;
    let takeover = false;
    state.updatePresentation((draft) => {
      // A queued optional request arrives only when it reaches the dock; reconnects
      // and persistence initialization keep the already chosen disclosure.
      draft.asyncQuestionIds = new Set(asyncIds?.filter((id) => draft.asyncQuestionIds.has(id)));
      const newGateway = gatewayIds.find((id) => !draft.gatewayQuestionIds.has(id));
      draft.gatewayQuestionIds = new Set(gatewayIds);
      if (newGateway && !gatewayIds.some((id) => draft.activeQuestionKey === `gateway:${id}`)) {
        draft.activeQuestionKey = `gateway:${newGateway}`;
        draft.questionCollapsed = false;
      }
      let request = requests.find((item) => item.key === draft.activeQuestionKey);
      if (!request) {
        request = requests[0];
        draft.activeQuestionKey = request?.key ?? null;
        if (request?.asyncIdentity === null) {
          draft.questionCollapsed = false;
        } else if (request && !draft.asyncQuestionIds.has(request.asyncIdentity)) {
          draft.questionCollapsed = editing;
        }
      }
      if (request?.asyncIdentity) {
        draft.asyncQuestionIds.add(request.asyncIdentity);
      }
      takeover = request?.asyncIdentity === null && !draft.questionCollapsed;
    });
    syncTakeover(takeover, data.draftKey);
  });
  return createMemo((): QuestionPanelProps | null => {
    // Panel actions retain the request generation that produced their rendered model.
    const staticRequestContext = source();
    const { requests } = staticRequestContext;
    const index = Math.max(
      0,
      requests.findIndex((request) => request.key === state.presentation.activeQuestionKey),
    );
    const request = requests[index];
    if (!request) {
      return null;
    }
    const selectRequest = (next: number) => {
      const selected = requests[next]!;
      state.updatePresentation((draft) => {
        draft.activeQuestionKey = selected.key;
        draft.questionCollapsed = false;
        if (selected.asyncIdentity) {
          draft.asyncQuestionIds.add(selected.asyncIdentity);
        }
      });
      syncTakeover(selected.asyncIdentity === null, staticRequestContext.draftKey);
    };
    return request.panel({
      collapsed: state.presentation.questionCollapsed,
      onCollapsedChange: (collapsed) => {
        state.updatePresentation((draft) => {
          draft.questionCollapsed = collapsed;
        });
        syncTakeover(request.asyncIdentity === null && !collapsed, staticRequestContext.draftKey);
        state.restoreComposerFocus = collapsed;
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
  });
}
