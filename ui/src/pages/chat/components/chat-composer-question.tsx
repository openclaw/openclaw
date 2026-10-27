import { createEffect, createMemo, Show } from "solid-js";
import type { ComposerQuestions } from "./chat-composer-questions.ts";
import { commitComposerDraft } from "./chat-composer-state.ts";
import type { QuestionPanelProps } from "./chat-question-card.ts";
import "./chat-question-card-view.tsx";

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
  readQuestions: () => ComposerQuestions,
  readComposition?: () => { key: string; value: string } | null,
  readTranscriptElement?: () => (() => HTMLElement | null) | undefined,
) {
  // Disclosure is derived at the pane; only native IME/focus custody belongs here.
  createEffect(
    () => {
      const questions = readQuestions();
      const source = questions.source();
      const request = source?.requests.find(
        (item) => item.key === questions.disclosure.activeQuestionKey,
      );
      return {
        active: request?.asyncIdentity === null && !questions.disclosure.questionCollapsed,
        source,
        composition: readComposition?.(),
        state: questions.state,
      };
    },
    ({ active, source, composition, state }) => {
      if (
        active &&
        !state.questionTakeoverActive &&
        source &&
        composition?.key === source.draftKey
      ) {
        // Input cleanup may already have run; the captured IME preview still owns this draft.
        commitComposerDraft(source.props, composition.value);
      }
      state.restoreComposerFocus ||= !active && state.questionTakeoverActive;
      state.questionTakeoverActive = active;
      if (active) {
        state.composerComposing = false;
      }
      // A derived disclosure can mount the input before this effect applies.
      if (!active && state.restoreComposerFocus && state.composerTextarea?.isConnected) {
        state.restoreComposerFocus = false;
        state.composerTextarea.focus({ preventScroll: true });
      }
    },
  );
  return createMemo((): QuestionPanelProps | null => {
    const questions = readQuestions();
    const state = questions.state;
    const source = questions.source();
    if (!source) {
      return null;
    }
    const { requests } = source;
    const index = Math.max(
      0,
      requests.findIndex((request) => request.key === questions.disclosure.activeQuestionKey),
    );
    const request = requests[index];
    if (!request) {
      return null;
    }
    const selectRequest = (next: number) => {
      const selected = requests[next]!;
      questions.select(selected.key);
    };
    const panel = request.panel({
      collapsed: questions.disclosure.questionCollapsed,
      onCollapsedChange: (collapsed) => {
        questions.setCollapsed(collapsed);
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
    return {
      ...panel,
      getTranscriptElement: readTranscriptElement?.() ?? source.props.getTranscriptElement,
    };
  });
}
