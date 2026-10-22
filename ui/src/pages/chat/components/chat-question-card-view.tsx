import { createMemo, createSignal, Errored, lazy, Loading, onSettled, Show } from "solid-js";
import {
  cancelStaleChunkRecovery,
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
} from "../../../app/stale-chunk-reload.ts";
import { LazyViewError } from "../../../components/solid/lazy-view-error.tsx";
import { LoadingState } from "../../../components/solid/loading-state.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import type { QuestionPanelProps } from "./chat-question-types.ts";

type CardProps = { props?: QuestionPanelProps };
export type ChatQuestionCard = SolidBridgeElement<CardProps>;

// Summaries and panel props are needed during chat boot; interactive controls are not.
const QuestionPanel = lazy(() => import("./chat-question-panel.tsx"), {
  export: "ChatQuestionPanel",
});

export const ChatQuestionCard = defineSolidBridge<CardProps>(
  "openclaw-chat-question-card",
  (props, host) => {
    host.style.display = "contents";
    return (
      <Show when={props.props}>
        {(panel) => <QuestionCardContents panel={panel()} host={host} />}
      </Show>
    );
  },
  { properties: { props: { default: undefined, attribute: false } } },
);

function QuestionCardContents(props: { panel: QuestionPanelProps; host: HTMLElement }) {
  const [attempt, setAttempt] = createSignal(0);
  return (
    <Loading on={attempt()} fallback={<LoadingState />}>
      <Errored
        fallback={(error, reset) => {
          const failedRequest = createMemo(() => [error(), props.panel.model.requestKey] as const, {
            equals: (before, after) => before[0] === after[0] && before[1] === after[1],
          });
          return (
            <Show when={failedRequest()} keyed>
              {([failure, requestKey]) => {
                const stale = isStaleChunkImportError(failure);
                const [recovery, setRecovery] = createSignal<Promise<boolean>>();
                const recovered = createMemo(() => recovery());
                let active = true;
                onSettled(() => () => {
                  active = false;
                  if (stale) {
                    cancelStaleChunkRecovery();
                  }
                });
                const retry = () => {
                  if (!active || !props.host.isConnected) {
                    return;
                  }
                  if (!stale) {
                    setAttempt((value) => value + 1);
                    reset();
                    return;
                  }
                  const isCurrent = () =>
                    active &&
                    props.host.isConnected &&
                    error() === failure &&
                    props.panel.model.requestKey === requestKey;
                  void setRecovery(
                    retryStaleChunkReloadWhenReachable({ canReload: isCurrent }).then(
                      (reloading) => {
                        if (!reloading && isCurrent()) {
                          setAttempt((value) => value + 1);
                          reset();
                        }
                        return reloading;
                      },
                    ),
                  );
                };
                return (
                  <Loading on={recovery()} fallback={<LoadingState />}>
                    {recovered()}
                    <LazyViewError
                      error={failure}
                      stale={stale}
                      subtitle={t("chat.questions.eyebrow")}
                      onRetry={retry}
                    />
                  </Loading>
                );
              }}
            </Show>
          );
        }}
      >
        <QuestionPanel props={props.panel} />
      </Errored>
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
