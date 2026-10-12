import { createEffect, createSignal, lazy, Loading, onCleanup } from "solid-js";
import {
  isOptionalElementDefined,
  LazyCustomElementRequestController,
} from "../../../app/lazy-custom-element.ts";
import { LazyViewError } from "../../../components/solid/lazy-view-error.tsx";
import { LoadingState } from "../../../components/solid/loading-state.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lit/solid-bridge.ts";
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
    const [revision, setRevision] = createSignal(0);
    let live = true;
    const loader = new LazyCustomElementRequestController({
      requestUpdate: () => {
        if (live) {
          setRevision((value) => value + 1);
        }
      },
    });
    createEffect(
      () => Boolean(props.props),
      (active) => loader.requestWhileActive(questionPanelElement, active),
    );
    onCleanup(() => {
      live = false;
      loader.requestWhileActive(questionPanelElement, false);
    });
    const loaded = () => {
      revision();
      return isOptionalElementDefined(questionPanelElement);
    };
    const failure = () => {
      revision();
      const value = loader.visibleState;
      return value?.status === "error" ? value : undefined;
    };
    return (
      <>
        {props.props && (
          <Loading fallback={<LoadingState />}>
            {loaded() ? (
              <QuestionPanel props={props.props} />
            ) : failure() ? (
              <LazyViewError
                error={failure()?.error}
                stale={failure()?.stale}
                subtitle={questionPanelElement.label}
                onRetry={() => loader.retry()}
              />
            ) : (
              <LoadingState />
            )}
          </Loading>
        )}
      </>
    );
  },
  { properties: { props: { default: undefined, attribute: false } } },
);

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-question-card": HTMLAttributes<ChatQuestionCard> & {
        "prop:props"?: ChatQuestionCard["props"];
      };
    }
  }
}
