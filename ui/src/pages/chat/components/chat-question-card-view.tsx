import { createEffect, createSignal, onCleanup } from "solid-js";
import {
  isOptionalElementDefined,
  LazyCustomElementRequestController,
} from "../../../app/lazy-custom-element.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { formatUiError } from "../../../lib/format-error.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lit/solid-bridge.ts";
import type { QuestionPanelProps } from "./chat-question-card.ts";

type CardProps = { props?: QuestionPanelProps };
export type ChatQuestionCard = SolidBridgeElement<CardProps>;

// Summaries and panel props are needed during chat boot; interactive controls are not.
const questionPanelElement = {
  tagName: "openclaw-chat-question-panel",
  get label() {
    return t("chat.questions.eyebrow");
  },
  loadModule: () => import("./chat-question-panel.tsx"),
};

export const ChatQuestionCard = defineSolidBridge<CardProps>(
  "openclaw-chat-question-card",
  (props, host) => {
    host.style.display = "contents";
    const [revision, setRevision] = createSignal(0);
    const loader = new LazyCustomElementRequestController({
      requestUpdate: () => setRevision((value) => value + 1),
    });
    createEffect(
      () => Boolean(props.props),
      (active) => loader.requestWhileActive(questionPanelElement, active),
    );
    onCleanup(() => loader.requestWhileActive(questionPanelElement, false));
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
          <>
            {loaded() ? (
              <openclaw-chat-question-panel prop:props={props.props} />
            ) : failure() ? (
              <div
                class={["lazy-view-error", { "lazy-view-error--stale": failure()?.stale }]}
                role="alert"
              >
                <div class="lazy-view-error__icon" aria-hidden="true">
                  <Icon name={failure()?.stale ? "refresh" : "alertTriangle"} />
                </div>
                <div class="lazy-view-error__title">
                  {t(failure()?.stale ? "lazyView.staleTitle" : "lazyView.errorTitle")}
                </div>
                <div class="lazy-view-error__subtitle">{questionPanelElement.label}</div>
                <div class="lazy-view-error__actions">
                  <button class="btn lazy-view-error__action" onClick={() => loader.retry()}>
                    {t(failure()?.stale ? "common.reload" : "lazyView.retry")}
                  </button>
                </div>
                <details class="lazy-view-error__details">
                  <summary>{t("chat.details")}</summary>
                  <code class="lazy-view-error__detail">{formatUiError(failure()?.error)}</code>
                </details>
              </div>
            ) : (
              <section
                class="lazy-view-state lazy-view-state--loading"
                role="status"
                aria-live="polite"
                aria-label={t("common.loading")}
              >
                <div class="loading-skeleton" aria-hidden="true">
                  <div class="loading-skeleton__header">
                    <div class="skeleton loading-skeleton__avatar" />
                    <div class="skeleton skeleton-line loading-skeleton__title" />
                  </div>
                  <div class="loading-skeleton__messages">
                    <div class="loading-skeleton__message loading-skeleton__message--user">
                      <div class="skeleton skeleton-line" />
                      <div class="skeleton skeleton-line skeleton-line--medium" />
                    </div>
                    <div class="loading-skeleton__message">
                      <div class="skeleton loading-skeleton__avatar" />
                      <div class="skeleton skeleton-line" />
                      <div class="skeleton skeleton-line skeleton-line--long" />
                      <div class="skeleton skeleton-line skeleton-line--medium" />
                    </div>
                  </div>
                  <div class="skeleton loading-skeleton__composer" />
                </div>
              </section>
            )}
          </>
        )}
      </>
    );
  },
  { properties: { props: { default: undefined, attribute: false } } },
);
