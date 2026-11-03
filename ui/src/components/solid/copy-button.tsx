import type { JSX as SolidJSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";
import { nativeListener } from "../../lib/solid-native-listener.ts";
import { handleCopyButton } from "../copy-button-state.ts";
import { Icon } from "./icon.tsx";
import "../tooltip.ts";
import "../../styles/copy-button.css";

export function CopyButton(props: {
  text: string;
  ref?: (element: HTMLButtonElement) => void;
  idleLabel?: string;
  bare?: boolean;
  /** Icon-only surfaces show failure as an icon and report outcomes in the tooltip. */
  iconFeedback?: boolean;
  buttonAttributes?: SolidJSX.ButtonHTMLAttributes<HTMLButtonElement> & {
    [name: `data-${string}`]: string | number | boolean | undefined;
  };
}): SolidJSX.Element {
  const label = () => props.idleLabel ?? t("chat.actions.copyAsMarkdown");
  return (
    <For each={[props.text]}>
      {(text) => {
        let feedback!: HTMLSpanElement;
        const [outcome, setOutcome] = createSignal<string>();
        return (
          <openclaw-tooltip prop:content={(props.iconFeedback && outcome()) || label()}>
            <button
              {...props.buttonAttributes}
              class={props.bare ? "chat-copy-btn" : "btn btn--xs chat-copy-btn"}
              type="button"
              aria-label={label()}
              ref={[
                (element) => props.ref?.(element),
                nativeListener(
                  "click",
                  (event) =>
                    void handleCopyButton(event, text, label(), {
                      feedback,
                      onFeedback: setOutcome,
                    }),
                ),
              ]}
            >
              <span class="chat-copy-btn__icon" aria-hidden="true">
                <span class="chat-copy-btn__icon-copy">
                  <Icon name="copy" />
                </span>
                <span class="chat-copy-btn__icon-check">
                  <Icon name="check" />
                </span>
                <Show when={props.iconFeedback}>
                  <span class="chat-copy-btn__icon-failed">
                    <Icon name="x" />
                  </span>
                </Show>
              </span>
            </button>
            <span ref={(element) => (feedback = element)} data-copy-feedback role="status" hidden />
          </openclaw-tooltip>
        );
      }}
    </For>
  );
}
