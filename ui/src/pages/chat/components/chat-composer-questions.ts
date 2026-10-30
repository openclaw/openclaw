import { createMemo, createStore, merge } from "solid-js";
import { createParkedProjection } from "../../../lib/reactive/parked-projection.ts";
import { projectPresentation } from "../../../lib/reactive/presentation.ts";
import { projectSource } from "../../../lib/reactive/projection.ts";
import type { ChatProps } from "../chat-view-frame.ts";
import {
  createAsyncQuestionPanelProps,
  createAsyncQuestionPresentation,
  subscribeAsyncQuestionState,
} from "./chat-async-question.ts";
import { composerDraftKey, getChatComposerState } from "./chat-composer-state.ts";
import type { ChatComposerProps } from "./chat-composer-types.ts";
import {
  createGatewayQuestionPanelProps,
  type QuestionPanelOptions,
} from "./chat-question-card.ts";
import { getTranscriptState } from "./chat-thread-interactions.ts";

type QuestionInput = ChatComposerProps &
  Partial<
    Pick<
      ChatProps,
      | "asyncQuestionStorage"
      | "onAsyncQuestionSubmit"
      | "getQueue"
      | "transcriptVisible"
      | "connectionEpoch"
    >
  >;

type QuestionDisclosure = {
  activeQuestionKey: string | null;
  gatewayQuestionIds: string[];
  asyncQuestionIds: string[];
  questionCollapsed: boolean;
};

/** One disclosure lifetime belongs to the pane, above replaceable composer renderers. */
export function createComposerQuestions(paneId: string, readProps: () => QuestionInput | null) {
  const state = getChatComposerState(paneId);
  const transcript = getTranscriptState(paneId);
  const revision = projectSource(transcript, {
    read: (owner) => owner.asyncQuestionRevision,
    subscribe: subscribeAsyncQuestionState,
    equality: "revision",
  });
  const visibility = createMemo(() => projectPresentation(readProps()?.transcriptVisible ?? true));
  const visibleRevision = createParkedProjection(
    () => revision.read(),
    () => visibility().read(),
  );
  const source = createMemo(() => {
    visibleRevision();
    const props = readProps();
    if (!props) {
      return null;
    }
    const asyncQuestions = createAsyncQuestionPresentation(
      transcript,
      merge(props, {
        queue: props.getQueue?.() ?? props.queue,
        onReopen: (itemId, scope) => {
          state.restoreComposerFocus ||= state.questionTakeoverActive;
          state.questionTakeoverActive = false;
          select(JSON.stringify([scope, itemId]));
        },
      } satisfies Partial<Parameters<typeof createAsyncQuestionPresentation>[1]>),
    );
    const gatewayQuestions =
      props.gatewayQuestionPrompts?.filter((prompt) => prompt.status === "pending") ?? [];
    const asyncIdentity = (itemId: string) =>
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
            ...(asyncQuestions.submit
              ? asyncQuestions.pending.map((question) => ({
                  key: JSON.stringify([asyncQuestions.scope, question.itemId]),
                  asyncIdentity: asyncIdentity(question.itemId),
                  panel: (options: QuestionPanelOptions) =>
                    createAsyncQuestionPanelProps(question, asyncQuestions, options),
                }))
              : []),
          ];
    return {
      props,
      asyncQuestions,
      requests,
      gatewayIds: gatewayQuestions.map((prompt) => prompt.id),
      asyncIds: asyncQuestions.pending.map((question) => asyncIdentity(question.itemId)),
      draftKey: composerDraftKey(props),
      editing:
        Boolean((props.draftSource?.read().draft ?? props.draft).trim()) ||
        (state.composerTextarea !== null && document.activeElement === state.composerTextarea),
    };
  });
  const [disclosure, update] = createStore<QuestionDisclosure>(
    (draft) => {
      const data = source();
      if (!data) {
        return;
      }
      const { requests, gatewayIds, asyncIds, editing } = data;
      // Preserve explicit choices across reconnects; only a newly arriving request chooses a default.
      draft.asyncQuestionIds = asyncIds.filter((id) => draft.asyncQuestionIds.includes(id));
      const newGateway = gatewayIds.find((id) => !draft.gatewayQuestionIds.includes(id));
      draft.gatewayQuestionIds = gatewayIds;
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
        } else if (request && !draft.asyncQuestionIds.includes(request.asyncIdentity)) {
          draft.questionCollapsed = editing;
        }
      }
      if (request?.asyncIdentity && !draft.asyncQuestionIds.includes(request.asyncIdentity)) {
        draft.asyncQuestionIds.push(request.asyncIdentity);
      }
    },
    {
      activeQuestionKey: null,
      gatewayQuestionIds: [],
      asyncQuestionIds: [],
      questionCollapsed: false,
    },
  );
  function select(key: string) {
    update((draft) => {
      draft.activeQuestionKey = key;
      draft.questionCollapsed = false;
      const request = source()?.requests.find((item) => item.key === key);
      if (request?.asyncIdentity && !draft.asyncQuestionIds.includes(request.asyncIdentity)) {
        draft.asyncQuestionIds.push(request.asyncIdentity);
      }
    });
  }
  return {
    state,
    source,
    disclosure,
    select,
    setCollapsed: (collapsed: boolean) =>
      update((draft) => {
        draft.questionCollapsed = collapsed;
      }),
  };
}

export type ComposerQuestions = ReturnType<typeof createComposerQuestions>;
