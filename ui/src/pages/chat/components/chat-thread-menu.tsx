import { Portal, render } from "@solidjs/web";
import { For } from "solid-js";
import { t } from "../../../i18n/index.ts";

export type ThreadMenuAction = {
  label: string;
  ariaLabel?: string;
  disabled?: boolean;
  tooltip?: string;
  className?: string;
  onClick: (event: Event) => void;
  element?: HTMLButtonElement;
};

export function mountThreadMenu(
  actions: readonly ThreadMenuAction[],
  parent: Element,
  x: number,
  y: number,
) {
  let element!: HTMLDivElement;
  const dispose = render(
    () => (
      <Portal mount={parent}>
        <div
          ref={(node) => {
            element = node;
          }}
          class="chat-reply-context-menu"
          role="menu"
          aria-label={t("chat.messages.actions")}
          style={{ left: `${x}px`, top: `${y}px` }}
        >
          <For each={actions}>
            {(action) => {
              const button = (
                <button
                  ref={(node) => {
                    action.element = node;
                  }}
                  type="button"
                  role="menuitem"
                  aria-label={action.ariaLabel}
                  disabled={action.disabled ?? false}
                  onClick={(event) => action.onClick(event)}
                >
                  {action.tooltip ? <span data-copy-label="">{action.label}</span> : action.label}
                </button>
              );
              return action.tooltip ? (
                <openclaw-tooltip prop:content={action.tooltip} class={action.className}>
                  {button}
                </openclaw-tooltip>
              ) : (
                button
              );
            }}
          </For>
        </div>
      </Portal>
    ),
    document.createElement("div"),
  );
  return { element, dispose };
}
