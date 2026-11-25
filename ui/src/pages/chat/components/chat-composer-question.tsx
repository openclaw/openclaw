import { createEffect, createMemo, Show } from "solid-js";
import { focusComposerInput } from "../../../lib/composer-input.ts";
import type { ComposerQuestions } from "./chat-composer-questions.ts";
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
  readTranscriptElement?: () => (() => HTMLElement | null) | undefined,
) {
  // Disclosure is derived at the pane; returning focus belongs to the composer.
  createEffect(
    () => {
      const questions = readQuestions();
      const source = questions.source();
      const request = source?.requests.find(
        (item) => item.key === questions.disclosure.activeQuestionKey,
      );
      return {
        active: request?.restoreComposerOnClose === true && !questions.disclosure.questionCollapsed,
        state: questions.state,
      };
    },
    ({ active, state }) => {
      state.restoreComposerFocus ||= !active && state.questionFocusActive;
      state.questionFocusActive = active;
      if (!active && state.restoreComposerFocus && state.composerTextarea?.isConnected) {
        state.restoreComposerFocus = false;
        focusComposerInput(state.composerTextarea, { preventScroll: true });
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
        state.restoreComposerFocus =
          collapsed && (request.restoreComposerOnClose || request.asyncIdentity !== null);
        if (collapsed) {
          queueMicrotask(() => {
            if (state.restoreComposerFocus && state.composerTextarea?.isConnected) {
              state.restoreComposerFocus = false;
              focusComposerInput(state.composerTextarea, { preventScroll: true });
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
