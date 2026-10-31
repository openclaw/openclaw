import { For, Show } from "solid-js";
import { registerChatSessionOptionalEnglish } from "../../../i18n/locales/en-chat-session-optional.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type { SubagentsPanelData } from "../subagents-panel-data.ts";

registerEnglishCatalog(registerChatSessionOptionalEnglish);

export function ChatSubagentsNative(props: {
  snapshot: SubagentsPanelData["nativeSnapshot"];
  error: SubagentsPanelData["nativeError"];
}) {
  return (
    <Show when={props.snapshot || props.error}>
      <section class="chat-subagents__native" aria-label={t("chat.subagentsPanel.nativeTitle")}>
        <h3>{t("chat.subagentsPanel.nativeTitle")}</h3>
        <p class="muted">{t("chat.subagentsPanel.nativeCoverage")}</p>
        <Show when={props.error}>
          <div class="chat-subagents__error" role="alert">
            <span>{props.error}</span>
            <span class="muted">{t("chat.subagentsPanel.nativeRetry")}</span>
          </div>
        </Show>
        <div role="list">
          <For each={props.snapshot?.children ?? []} keyed={(row) => row.id}>
            {(row) => (
              <div class="chat-subagents__item" role="listitem">
                <div class="chat-subagents__item-heading">
                  <span class="chat-subagents__activity">{row().label}</span>
                </div>
                <div class="chat-subagents__metadata">
                  <span>{t(`chat.subagentsPanel.nativeStatus.${row().status}`)}</span>
                </div>
              </div>
            )}
          </For>
        </div>
        <Show when={props.snapshot && !props.snapshot.children.length}>
          <p class="muted">{t("chat.subagentsPanel.nativeEmpty")}</p>
        </Show>
        <Show when={props.snapshot?.truncated}>
          <p class="muted">{t("chat.subagentsPanel.nativeTruncated")}</p>
        </Show>
      </section>
    </Show>
  );
}
