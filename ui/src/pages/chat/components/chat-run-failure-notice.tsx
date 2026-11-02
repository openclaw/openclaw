import { createMemo, createSignal, onSettled, Show } from "solid-js";
import { formatWebUiIconErrorText } from "../../../components/error-presentation.ts";
import { CopyButton } from "../../../components/solid/copy-button.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { Popover, type PopoverHandle } from "../../../components/solid/popover.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { createScrollStateRef } from "../../../lib/reactive/scroll-state.ts";

let nextPanelId = 0;

/** Details open away from the conversation's edges, so they never cover the composer. */
function panelPlacement(line: HTMLElement, panel: HTMLElement): "bottom" | "top" {
  const thread = line.closest(".chat-thread")?.getBoundingClientRect();
  const { top, bottom } = line.getBoundingClientRect();
  const distance = Number.parseFloat(getComputedStyle(panel).marginBlockStart) || 0;
  const below = (thread?.bottom ?? window.innerHeight) - bottom;
  const above = top - (thread?.top ?? 0);
  return below >= panel.offsetHeight + distance || below >= above ? "bottom" : "top";
}

/** One terminal notice, separate from assistant prose and preserved partial output. */
export function ChatRunFailureNotice(props: {
  summary: string;
  repeatCount?: number;
  onRetry?: () => void;
}) {
  const panelId = `chat-run-failure-${++nextPanelId}`;
  const [line, setLine] = createSignal<HTMLElement>();
  const [open, setOpen] = createSignal(false);
  const [placement, setPlacement] = createSignal<"bottom" | "top">("bottom");
  let panel: PopoverHandle | undefined;
  const detail = createMemo(() => formatWebUiIconErrorText(props.summary).trim());
  const concise = createMemo(() => {
    const firstLine = detail().split(/\r?\n/u)[0] ?? "";
    return firstLine.length <= 240 ? firstLine : t("chat.recovery.failedHelp");
  });
  // The well always holds the full error, so a one-line error is not repeated above it.
  const lead = createMemo(() =>
    concise() === detail() || concise() === t("chat.recovery.failedHelp") ? undefined : concise(),
  );
  const logRef = createScrollStateRef(
    (log, state) => {
      log.toggleAttribute("data-fade-top", !state.atStart);
      log.toggleAttribute("data-fade-bottom", !state.atEnd);
    },
    { presented: open, content: detail },
  );
  const place = () => {
    const anchor = line();
    if (anchor && panel) {
      setPlacement(panelPlacement(anchor, panel.overlay.surface));
    }
  };
  let stopFollowing: (() => void) | undefined;
  onSettled(() => () => stopFollowing?.());
  return (
    <openclaw-chat-run-failure-notice style={{ display: "contents" }}>
      <div class="chat-run-failure" role="status" data-placement={placement()} ref={setLine}>
        <Popover
          id={panelId}
          class="chat-run-failure__panel"
          label={t("chat.recovery.failedTitle")}
          positionAnchor={line()}
          placement={placement()}
          triggerClass="chat-run-failure__toggle"
          triggerAriaLabel={null}
          trigger={
            <>
              <span class="chat-run-failure__icon" aria-hidden="true">
                <Icon name="circleX" />
              </span>
              <span class="chat-run-failure__title">{t("chat.recovery.failedTitle")}</span>
              <Show when={(props.repeatCount ?? 1) > 1}>
                <span class="chat-run-failure__repeat">
                  · {t("chat.recovery.failedRepeatCount", { count: String(props.repeatCount) })}
                </span>
              </Show>
              <span class="chat-run-failure__chevron" aria-hidden="true">
                <Icon name="chevronRight" />
              </span>
            </>
          }
          ref={(handle) => {
            panel = handle;
          }}
          onOpenChange={(next) => {
            stopFollowing?.();
            stopFollowing = undefined;
            if (next) {
              place();
              const initialAnchor = line();
              const thread = initialAnchor?.closest(".chat-thread");
              if (initialAnchor && thread) {
                // The accepted overlay lifetime owns following its transcript anchor.
                const follow = () => {
                  const { top, bottom } = initialAnchor.getBoundingClientRect();
                  const bounds = thread.getBoundingClientRect();
                  if (bottom <= bounds.top || top >= bounds.bottom) {
                    panel?.hide();
                  } else {
                    place();
                  }
                };
                const stops = [
                  listen(thread, "scroll", follow, { passive: true }),
                  listen(window, "resize", place),
                ];
                stopFollowing = () => stops.forEach((stop) => stop());
              }
            }
            setOpen(next);
          }}
        >
          <p class="chat-run-failure__summary">
            <Show when={lead()}>
              <bdi>{lead()}</bdi>{" "}
            </Show>
            {t("chat.recovery.failedHelp")}
          </p>
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
              <CopyButton text={props.summary} idleLabel={t("chat.copyError")} bare iconFeedback />
            </span>
          </div>
        </Popover>
        <Show when={props.onRetry}>
          <button
            type="button"
            class="btn primary btn--sm chat-run-failure__retry"
            onClick={() => props.onRetry?.()}
          >
            <Icon name="refresh" />
            {t("chat.recovery.tryAgain")}
          </button>
        </Show>
      </div>
    </openclaw-chat-run-failure-notice>
  );
}
