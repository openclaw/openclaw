import { Dynamic } from "@solidjs/web";
import { createMemo, createSignal, For, lazy, Loading, Show } from "solid-js";
import type { RunFailureCause } from "../../../../../src/shared/run-failure-notice.js";
import { formatWebUiIconErrorText } from "../../../components/error-presentation.ts";
import { providerDisplayLabel } from "../../../components/provider-icon-data.ts";
import { ReportIssueLink } from "../../../components/report-issue-link.tsx";
import { revealInScrollRegion } from "../../../components/scroll-state.ts";
import { CopyButton } from "../../../components/solid/copy-button.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { useOptionalApplication } from "../../../lib/reactive/context.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { createResizeObserver } from "../../../lib/reactive/observers.ts";
import type { FailedMessageEditSource } from "../failed-message-edit.ts";
import { openChatRewindConfirmation } from "./chat-message-confirmation-view.tsx";

// Failure facts and continuation stay eager; only this optional action is deferred.
const ChatFailedMessageEditButton = lazy(() => import("./chat-failed-message-edit-button.tsx"));

let nextSummaryId = 0;
// A rejected key or billing problem is fixed under Models, not by another attempt.
const FIX_TITLES = new Map([
  ["auth", "credentialsRejected"],
  ["auth_permanent", "credentialsRejected"],
  ["billing", "billingProblem"],
]);

/** One terminal notice, separate from assistant prose and preserved partial output. */
export function ChatRunFailureNotice(props: {
  summary: string;
  cause?: RunFailureCause;
  repeatCount?: number;
  onRetry?: () => void;
  editSource?: FailedMessageEditSource;
  onFocusComposer?: () => void;
}) {
  const summaryId = `chat-run-failure-${++nextSummaryId}`;
  const [line, setLine] = createSignal<HTMLElement>();
  const [open, setOpen] = createSignal(false);
  const [clamped, setClamped] = createSignal(false);
  let paragraph!: HTMLParagraphElement;
  const expandable = () => open() || clamped();
  const fixTitle = () => props.cause && FIX_TITLES.get(props.cause.failoverReason!);
  const title = () =>
    t(`chat.recovery.${fixTitle() ?? "failedTitle"}`, {
      provider: providerDisplayLabel(props.cause?.provider ?? ""),
    });
  const app = useOptionalApplication();
  const openModels = () => (app && fixTitle() ? props.cause?.provider : undefined);
  const detail = createMemo(() => formatWebUiIconErrorText(props.summary).trim());
  const parts = createMemo(() => detail().split(/`([^`]+)`/gu));
  createResizeObserver(
    () => {
      // Text can change overflow without changing the clamped paragraph's size.
      detail();
      return open() ? [] : [paragraph];
    },
    () => setClamped(paragraph.scrollHeight > paragraph.clientHeight),
  );
  // Follow the card's growth inside the transcript, without moving ancestor scrollers.
  createResizeObserver(
    () => (open() && line() ? [line()!] : []),
    () => {
      const card = line();
      const thread = card?.closest<HTMLElement>(".chat-thread");
      if (card && thread) {
        revealInScrollRegion(thread, card);
      }
    },
  );
  return (
    <openclaw-chat-run-failure-notice style={{ display: "contents" }}>
      <div class="chat-run-failure" role="status" data-open={String(open())} ref={setLine}>
        <Dynamic
          component={expandable() ? "button" : "div"}
          type={expandable() ? "button" : undefined}
          class="chat-run-failure__toggle"
          aria-expanded={expandable() ? (open() ? "true" : "false") : undefined}
          aria-controls={expandable() ? summaryId : undefined}
          onClick={expandable() ? () => setOpen((value) => !value) : undefined}
        >
          <span class="chat-run-failure__icon" aria-hidden="true">
            <Icon name="circleX" />
          </span>
          <span class="chat-run-failure__title">
            {title()}
            <Show when={(props.repeatCount ?? 1) > 1}>
              <span class="chat-run-failure__repeat">
                {" "}
                · {t("chat.recovery.failedRepeatCount", { count: String(props.repeatCount) })}
              </span>
            </Show>
          </span>
          <Show when={expandable()}>
            <span class="chat-run-failure__chevron" aria-hidden="true">
              <Icon name="chevronRight" />
            </span>
          </Show>
        </Dynamic>
        <p
          id={summaryId}
          class="chat-run-failure__summary"
          ref={(element) => (paragraph = element)}
        >
          <bdi>
            <For each={parts()} keyed={false}>
              {(part, index) => (index % 2 ? <code>{part()}</code> : <>{part()}</>)}
            </For>
          </bdi>
        </p>
        <div class="chat-run-failure__actions">
          <Show when={openModels()}>
            {(provider) => (
              <button
                type="button"
                class="btn primary btn--sm chat-run-failure__retry"
                onClick={() =>
                  app?.navigate("model-providers", {
                    search: `?provider=${encodeURIComponent(provider())}`,
                  })
                }
              >
                {t("chat.recovery.openModels")}
              </button>
            )}
          </Show>
          <Show when={props.onRetry}>
            <button
              type="button"
              class={["btn btn--sm chat-run-failure__retry", { primary: !openModels() }]}
              onClick={() => props.onRetry?.()}
            >
              <Icon name="refresh" />
              {t("chat.recovery.tryAgain")}
            </button>
          </Show>
          <Show when={props.editSource}>
            <Loading fallback={null}>
              <ChatFailedMessageEditButton
                source={props.editSource}
                confirm={openChatRewindConfirmation}
                onFocusComposer={props.onFocusComposer}
              />
            </Loading>
          </Show>
          <span class="chat-run-failure__copy">
            <CopyButton text={props.summary} idleLabel={t("chat.copyError")} bare iconFeedback />
          </span>
          <Show when={props.onRetry || props.editSource || openModels()}>
            <ReportIssueLink />
          </Show>
        </div>
      </div>
    </openclaw-chat-run-failure-notice>
  );
}
