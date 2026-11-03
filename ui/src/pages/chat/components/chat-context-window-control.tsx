import { createMemo, For, Show } from "solid-js";
import type { GatewayContextWindowOption } from "../../../api/types.ts";
import { registerModelControlsEnglish } from "../../../i18n/locales/en-model-controls.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { nativeListener } from "../../../lib/solid-native-listener.ts";

registerModelControlsEnglish();

export type ChatContextWindowControlParams = {
  options: readonly GatewayContextWindowOption[];
  selected: string;
  defaultId?: string;
  disabled: boolean;
  onSelect: (next: string, sessionKey: string) => Promise<void>;
};

export function ChatContextWindowControl(props: {
  contextWindow: ChatContextWindowControlParams;
  sessionKey: string;
}) {
  const selectedOption = createMemo(() =>
    props.contextWindow.options.find((option) => option.id === props.contextWindow.selected),
  );
  // Native listeners contain clicks before the surrounding picker handles them.
  return (
    <Show when={selectedOption()}>
      {(selected) => (
        <div class="chat-controls__fast-mode-row chat-controls__context-window-row">
          <span class="chat-controls__settings-label">{t("chat.modelControls.contextWindow")}</span>
          <div
            class="settings-segmented chat-controls__context-window-options settings-segmented--compact"
            role="group"
            aria-label={t("chat.modelControls.contextWindowAria", { state: selected().label })}
          >
            <For
              each={props.contextWindow.options.toSorted(
                (a, b) => a.contextWindow - b.contextWindow,
              )}
              keyed={(option) => option.id}
            >
              {(option) => (
                <button
                  class={[
                    "settings-segmented__btn",
                    { "settings-segmented__btn--active": option().id === selected().id },
                  ]}
                  type="button"
                  aria-pressed={option().id === selected().id ? "true" : "false"}
                  disabled={props.contextWindow.disabled}
                  ref={nativeListener("click", (event) => {
                    event.stopPropagation();
                    if (props.contextWindow.disabled || option().id === selected().id) {
                      event.preventDefault();
                      return;
                    }
                    void props.contextWindow.onSelect(option().id, props.sessionKey);
                  })}
                >
                  {option().label}
                </button>
              )}
            </For>
          </div>
        </div>
      )}
    </Show>
  );
}
