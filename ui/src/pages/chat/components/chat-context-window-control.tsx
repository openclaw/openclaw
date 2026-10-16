import { createMemo, For, Show } from "solid-js";
import type { GatewayContextWindowOption } from "../../../api/types.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerModelControlsEnglish } from "../../../i18n/locales/en-model-controls.ts";
import { t } from "../../../lib/reactive/i18n.ts";

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
  const toggle = createMemo(() => {
    if (props.contextWindow.options.length !== 2) {
      return undefined;
    }
    const [smaller, larger] = props.contextWindow.options.toSorted(
      (left, right) => left.contextWindow - right.contextWindow,
    );
    if (!smaller || !larger) {
      return undefined;
    }
    const active = selectedOption()?.id === larger.id;
    return { active, next: active ? smaller.id : larger.id };
  });

  // Native listeners contain clicks before the surrounding picker handles them.
  return (
    <Show when={selectedOption()}>
      {(selected) => (
        <div class="chat-controls__fast-mode-row chat-controls__context-window-row">
          <span
            class="chat-controls__fast-mode-icon chat-controls__context-window-icon"
            aria-hidden="true"
          >
            <Icon name="scrollText" />
          </span>
          <span class="chat-controls__fast-mode-copy">
            <span class="chat-controls__fast-mode-title">
              {t("chat.modelControls.contextWindow")}
            </span>
            <span class="chat-controls__fast-mode-description">{selected().label}</span>
          </span>
          <Show
            when={toggle()}
            fallback={
              <div
                class="settings-segmented chat-controls__context-window-options settings-segmented--compact"
                role="group"
                aria-label={t("chat.modelControls.contextWindowAria", { state: selected().label })}
              >
                <For each={props.contextWindow.options} keyed={(option) => option.id}>
                  {(option) => (
                    <button
                      class={[
                        "settings-segmented__btn",
                        { "settings-segmented__btn--active": option().id === selected().id },
                      ]}
                      type="button"
                      aria-pressed={option().id === selected().id ? "true" : "false"}
                      disabled={props.contextWindow.disabled}
                      ref={(element) => {
                        element.addEventListener("click", (event) => {
                          event.stopPropagation();
                          if (props.contextWindow.disabled || option().id === selected().id) {
                            event.preventDefault();
                            return;
                          }
                          void props.contextWindow.onSelect(option().id, props.sessionKey);
                        });
                      }}
                    >
                      {option().label}
                    </button>
                  )}
                </For>
              </div>
            }
          >
            {(control) => (
              <button
                class={[
                  "chat-controls__speed-toggle",
                  { "chat-controls__speed-toggle--active": control().active },
                ]}
                data-chat-context-window-toggle={control().next}
                type="button"
                role="switch"
                aria-checked={control().active ? "true" : "false"}
                aria-label={t("chat.modelControls.contextWindowAria", { state: selected().label })}
                disabled={props.contextWindow.disabled}
                ref={(element) => {
                  element.addEventListener("click", (event) => {
                    event.stopPropagation();
                    if (props.contextWindow.disabled) {
                      event.preventDefault();
                      return;
                    }
                    void props.contextWindow.onSelect(control().next, props.sessionKey);
                  });
                }}
              >
                <span class="chat-controls__speed-toggle-thumb" />
              </button>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}
