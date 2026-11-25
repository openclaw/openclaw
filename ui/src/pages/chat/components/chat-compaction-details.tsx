import { Show } from "solid-js";
import type { ChatCompaction } from "../../../lib/chat/chat-types.ts";
import { formatCompactTokenCount, formatTimeMs } from "../../../lib/format.ts";
import { t } from "../../../lib/reactive/i18n.ts";

export function formatCompactionSavings(tokensBefore?: number, tokensAfter?: number) {
  if (
    tokensBefore == null ||
    tokensAfter == null ||
    !Number.isFinite(tokensBefore) ||
    !Number.isFinite(tokensAfter) ||
    tokensAfter < 0 ||
    tokensBefore <= tokensAfter
  ) {
    return undefined;
  }
  const saved = tokensBefore - tokensAfter;
  return t("chat.compaction.savedTokensWithPercent", {
    count: formatCompactTokenCount(Math.floor(saved)),
    percent: String(Math.round((saved / tokensBefore) * 1000) / 10),
  });
}

export function ChatCompactionDetails(props: { item: ChatCompaction }) {
  return (
    <div class="chat-tool-msg-body muted">
      <div class="chat-tool-kv">
        <Show when={formatCompactionSavings(props.item.tokensBefore, props.item.tokensAfter)}>
          {(metric) => <div>{metric()}</div>}
        </Show>
        <Show when={props.item.durationMs != null}>
          {t("chat.compaction.duration", {
            duration: `${((props.item.durationMs ?? 0) / 1000).toFixed(1)}s`,
          })}
        </Show>
        <div>{formatTimeMs(props.item.timestamp)}</div>
      </div>
    </div>
  );
}
