import type { JSX as SolidJSX } from "@solidjs/web";
import { For } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";
import { nativeListener } from "../../lib/solid-native-listener.ts";
import { handleCopyButton } from "../copy-button-state.ts";
import { Icon } from "./icon.tsx";
import "../tooltip.ts";
import "../../styles/copy-button.css";

export type CopyButtonProps = {
  text: string;
  idleLabel?: string;
  bare?: boolean;
  buttonAttributes?: SolidJSX.ButtonHTMLAttributes<HTMLButtonElement> & {
    [name: `data-${string}`]: string | number | boolean | undefined;
  };
};

export function CopyButton(props: CopyButtonProps): SolidJSX.Element {
  const label = () => props.idleLabel ?? t("chat.actions.copyAsMarkdown");
  return (
    <For each={[props.text]}>
      {(text) => (
        <openclaw-tooltip prop:content={label()}>
          <button
            {...props.buttonAttributes}
            class={props.bare ? "chat-copy-btn" : "btn btn--xs chat-copy-btn"}
            type="button"
            aria-label={label()}
            ref={nativeListener("click", (event) => void handleCopyButton(event, text, label()))}
          >
            <span class="chat-copy-btn__icon" aria-hidden="true">
              <span class="chat-copy-btn__icon-copy">
                <Icon name="copy" />
              </span>
              <span class="chat-copy-btn__icon-check">
                <Icon name="check" />
              </span>
            </span>
          </button>
          <span data-copy-feedback role="status" hidden />
        </openclaw-tooltip>
      )}
    </For>
  );
}
