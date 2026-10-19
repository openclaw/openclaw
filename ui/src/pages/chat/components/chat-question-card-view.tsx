import { createMemo, lazy, Loading, onSettled, Show } from "solid-js";
import {
  isOptionalElementDefined,
  createLazyCustomElementRequests,
} from "../../../app/lazy-custom-element.ts";
import { LazyViewError } from "../../../components/solid/lazy-view-error.tsx";
import { LoadingState } from "../../../components/solid/loading-state.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { projectOwner } from "../../../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import type { QuestionPanelProps } from "./chat-question-types.ts";

type CardProps = { props?: QuestionPanelProps };
export type ChatQuestionCard = SolidBridgeElement<CardProps>;

// Summaries and panel props are needed during chat boot; interactive controls are not.
const QuestionPanel = lazy(() => import("./chat-question-panel.tsx"), {
  export: "ChatQuestionPanel",
});
const questionPanelElement = {
  tagName: "openclaw-chat-question-panel",
  get label() {
    return t("chat.questions.eyebrow");
  },
  loadModule: QuestionPanel.preload,
};

export const ChatQuestionCard = defineSolidBridge<CardProps>(
  "openclaw-chat-question-card",
  (props, host) => {
    host.style.display = "contents";
    return <Show when={props.props}>{(panel) => <QuestionCardContents panel={panel()} />}</Show>;
  },
  { properties: { props: { default: undefined, attribute: false } } },
);

function QuestionCardContents(props: { panel: QuestionPanelProps }) {
  const loader = createLazyCustomElementRequests();
  const loadState = projectOwner(loader, (owner) => owner.visibleState);
  onSettled(() => {
    loader.requestWhileActive(questionPanelElement, true);
    return () => loader.requestWhileActive(questionPanelElement, false);
  });
  const view = createMemo(() => {
    const value = loadState.read();
    return {
      loaded: isOptionalElementDefined(questionPanelElement),
      failure: value?.status === "error" ? value : undefined,
    };
  });
  return (
    <Loading fallback={<LoadingState />}>
      {view().loaded ? (
        <QuestionPanel props={props.panel} />
      ) : view().failure ? (
        <LazyViewError
          error={view().failure?.error}
          stale={view().failure?.stale}
          subtitle={questionPanelElement.label}
          onRetry={() => loader.retry()}
        />
      ) : (
        <LoadingState />
      )}
    </Loading>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-question-card": HTMLAttributes<ChatQuestionCard> & {
        "prop:props"?: ChatQuestionCard["props"];
      };
    }
  }
}
