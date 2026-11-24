import { Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import type { ChatCompaction } from "../../../lib/chat/chat-types.ts";
import { formatTimeMs } from "../../../lib/format.ts";
import { t } from "../../../lib/reactive/i18n.ts";

export function ChatCompactionActivity(props: { item: ChatCompaction }) {
  return (
    <details
      class="chat-tool-msg-collapse chat-compaction-activity"
      data-chat-row-key={props.item.key}
      data-ts={String(props.item.timestamp)}
    >
      <summary class="chat-inline-disclosure chat-tool-msg-summary chat-tool-row">
        <span class="chat-tool-msg-summary__icon">
          <Icon name="layers" />
        </span>
        <span class="chat-tool-disclosure__content" role="status" aria-live="polite">
          <span class={["chat-tool-row__title", { "text-shimmer": props.item.phase === "active" }]}>
            {props.item.label}
          </span>
        </span>
        <span class="chat-tool-row__chevron" aria-hidden="true">
          <Icon name="chevronRight" />
        </span>
      </summary>
      <div class="chat-tool-msg-body muted">
        <div class="chat-tool-kv">
          <Show when={props.item.metric}>{(metric) => <div>{metric()}</div>}</Show>
          <Show when={props.item.durationMs != null}>
            {t("chat.compaction.duration", {
              duration: `${((props.item.durationMs ?? 0) / 1000).toFixed(1)}s`,
            })}
          </Show>
          <div>{formatTimeMs(props.item.timestamp)}</div>
        </div>
      </div>
    </details>
  );
}
