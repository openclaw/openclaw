import { createMemo, For, Show } from "solid-js";
import type { SubagentCompletion } from "../../../../../src/shared/subagent-completion.js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatToolLabelsEnglish } from "../../../i18n/locales/en-chat-tool-labels.ts";
import { getLocale, registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { subagentCompletionNames } from "../chat-spawned-subagent.ts";

registerEnglishCatalog(registerChatToolLabelsEnglish);

export function ChatSubagentCompletion(props: {
  completions: readonly SubagentCompletion[];
  onOpenSession?: (key: string) => void;
}) {
  const names = createMemo(() => subagentCompletionNames(props.completions));
  const parts = createMemo(() => {
    if (props.completions.some((entry) => !entry.label)) {
      return [{ type: "literal", value: names() }];
    }
    return new Intl.ListFormat(getLocale(), { type: "conjunction" }).formatToParts([
      ...props.completions.slice(0, 2).map((_, index) => String(index)),
      ...(props.completions.length > 2 ? ["more"] : []),
    ]);
  });
  const sentence = createMemo(() => {
    const marker = "￼";
    return t("chat.toolCards.agentsFinished", { names: marker }).split(marker);
  });
  return (
    <div
      class="chat-tool-msg-summary chat-tool-row chat-tool-row--subagent"
      aria-label={t("chat.toolCards.agentsFinished", { names: names() })}
    >
      <span class="chat-tool-msg-summary__icon" aria-hidden="true">
        <Icon name="bot" />
      </span>
      <span class="chat-tool-disclosure__content" style={{ gap: "0" }}>
        <span class="chat-tool-row__verb" style={{ "white-space": "pre" }}>
          {sentence()[0]}
        </span>
        <span class="chat-tool-row__title" title={names()}>
          <For each={parts()} keyed={(part) => part.type + part.value}>
            {(part) => (
              <Show when={part().type === "element"} fallback={part().value}>
                <Show
                  when={part().value !== "more"}
                  fallback={t("chat.toolCards.lifecycleMoreCount", {
                    count: String(props.completions.length - 2),
                  })}
                >
                  <Show
                    when={props.onOpenSession}
                    fallback={props.completions[Number(part().value)]?.label}
                  >
                    <button
                      type="button"
                      class="chat-tool-row__subagent-link"
                      onClick={() => {
                        const entry = props.completions[Number(part().value)];
                        if (entry) {
                          props.onOpenSession?.(entry.sessionKey);
                        }
                      }}
                    >
                      {props.completions[Number(part().value)]?.label}
                    </button>
                  </Show>
                </Show>
              </Show>
            )}
          </For>
        </span>
        <span class="chat-tool-row__verb" style={{ "white-space": "pre" }}>
          {sentence()[1]}
        </span>
      </span>
    </div>
  );
}
