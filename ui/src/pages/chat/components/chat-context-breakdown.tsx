import { For, Show, createMemo, type Element } from "solid-js";
import { formatCompactTokenCount } from "../../../lib/format.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { buildChatContextCategories } from "./chat-context-breakdown-model.ts";
import {
  ChatContextReport,
  contextLabelKeys,
  type ContextReportProps,
} from "./chat-context-report.tsx";
import "../../../styles/chat/context-breakdown.css";

export function ChatContextBreakdown(
  props: ContextReportProps & {
    limit: number;
    approximate?: boolean;
    popover?: boolean;
    loadingFallback?: Element;
  },
) {
  return (
    <ChatContextReport {...props}>
      {(result) => (
        <div class={["chat-context", { "chat-context--popover": props.popover }]}>
          <Show when={!result().loading || result().report} fallback={props.loadingFallback}>
            <Show
              when={result().report}
              fallback={
                <p class="chat-context__note" role="status">
                  {t(
                    result().offline
                      ? "chat.sessionDetails.contextOffline"
                      : result().failed
                        ? "chat.sessionDetails.contextError"
                        : "chat.sessionDetails.contextUnavailable",
                  )}
                </p>
              }
            >
              {(report) => {
                const categories = createMemo(() =>
                  buildChatContextCategories(report(), props.used),
                );
                return (
                  <>
                    <div class="chat-context__bar" aria-hidden="true">
                      <For each={categories()} keyed={(category) => category.id}>
                        {(category) => (
                          <span
                            class={["chat-context__segment", `chat-context__${category().id}`]}
                            style={{
                              width:
                                Math.min(100, ((category().tokens ?? 0) / props.limit) * 100) + "%",
                            }}
                          />
                        )}
                      </For>
                    </div>
                    <div class="chat-context__legend">
                      <For each={categories()} keyed={(category) => category.id}>
                        {(category) => (
                          <div class="chat-context__row" data-context-category={category().id}>
                            <span
                              class={["chat-context__swatch", `chat-context__${category().id}`]}
                              aria-hidden="true"
                            />
                            <span class="chat-context__label">
                              {t("chat.sessionDetails." + contextLabelKeys[category().id])}
                            </span>
                            <span class="chat-context__tokens">
                              {category().tokens === null
                                ? t("chat.sessionDetails.contextUnverified")
                                : "~" + formatCompactTokenCount(category().tokens!)}
                            </span>
                          </div>
                        )}
                      </For>
                    </div>
                  </>
                );
              }}
            </Show>
          </Show>
        </div>
      )}
    </ChatContextReport>
  );
}
