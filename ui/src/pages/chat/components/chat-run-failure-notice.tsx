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
import { createScrollStateRef } from "../../../lib/reactive/scroll-state.ts";
import type { FailedMessageEditSource } from "../failed-message-edit.ts";
import { openChatRewindConfirmation } from "./chat-message-confirmation-view.tsx";

// Failure facts and continuation stay eager; only this optional action is deferred.
const ChatFailedMessageEditButton = lazy(() => import("./chat-failed-message-edit-button.tsx"));

let nextPanelId = 0;
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
  const panelId = `chat-run-failure-${++nextPanelId}`;
  const [line, setLine] = createSignal<HTMLElement>();
  const [open, setOpen] = createSignal(false);
  const fixTitle = () => props.cause && FIX_TITLES.get(props.cause.failoverReason!);
  const title = () =>
    t(`chat.recovery.${fixTitle() ?? "failedTitle"}`, {
      provider: providerDisplayLabel(props.cause?.provider ?? ""),
    });
  const app = useOptionalApplication();
  const openModels = () => (app && fixTitle() ? props.cause?.provider : undefined);
  const detail = createMemo(() => formatWebUiIconErrorText(props.summary).trim());
  const firstLine = createMemo(() => (detail().split(/\r?\n/u)[0] ?? "").split(/`([^`]+)`/gu));
  const logRef = createScrollStateRef(
    (log, state) => {
      log.toggleAttribute("data-fade-top", !state.atStart);
      log.toggleAttribute("data-fade-bottom", !state.atEnd);
    },
    { presented: open, content: detail },
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
        <button
          type="button"
          class="chat-run-failure__toggle"
          aria-expanded={open() ? "true" : "false"}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
        >
          <span class="chat-run-failure__icon" aria-hidden="true">
            <Icon name="circleX" />
          </span>
          <span class="chat-run-failure__title">
            {title()}
            <Show when={(props.repeatCount ?? 1) > 1}>
              <span class="chat-run-failure__repeat">
                {" "}· {t("chat.recovery.failedRepeatCount", { count: String(props.repeatCount) })}
              </span>
            </Show>
          </span>
          <span class="chat-run-failure__chevron" aria-hidden="true">
            <Icon name="chevronRight" />
          </span>
        </button>
        <div class="chat-run-failure__summary-collapse" inert={open()}>
          <div>
            <p class="chat-run-failure__summary">
              <bdi>
                <For each={firstLine()} keyed={false}>
                  {(part, index) => (index % 2 ? <code>{part()}</code> : <>{part()}</>)}
                </For>
              </bdi>
            </p>
          </div>
        </div>
        <div id={panelId} class="chat-run-failure__panel" inert={!open()}>
          <div>
            {/* Logs are technical strings, so they stay left to right in every locale. */}
            <div class="chat-run-failure__well" dir="ltr">
              <pre
                ref={logRef}
                class="chat-run-failure__log"
                tabindex="0"
                aria-label={t("chat.errorDetails")}
              >
                {detail()}
              </pre>
              <span class="chat-run-failure__copy">
                <CopyButton
                  text={props.summary}
                  idleLabel={t("chat.copyError")}
                  bare
                  iconFeedback
                />
              </span>
            </div>
          </div>
        </div>
        <Show when={props.onRetry || props.editSource || openModels()}>
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
            <ReportIssueLink />
          </div>
        </Show>
      </div>
    </openclaw-chat-run-failure-notice>
  );
}
