import { Portal, render } from "@solidjs/web";
import { For } from "solid-js";
import { t } from "../../../i18n/index.ts";

export type ThreadMenuAction = {
  label: string;
  ariaLabel?: string;
  disabled?: boolean;
  tooltip?: string;
  className?: string;
  onClick: (event: Event, label?: HTMLSpanElement) => void;
};

/**
 * Roving focus for the menu's `role="menuitem"` buttons: Arrow keys step with
 * wrapping, Home/End jump to the edges, and disabled or detached actions are
 * skipped. Returns true when the key was a menu navigation key.
 */
export function moveThreadMenuFocus(menu: Element, key: string): boolean {
  if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") {
    return false;
  }
  const enabledItems = [
    ...menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'),
  ].filter((button) => !button.disabled && button.isConnected);
  if (enabledItems.length === 0) {
    return false;
  }
  const currentIndex = enabledItems.findIndex((item) => item === document.activeElement);
  let nextTarget: HTMLButtonElement | undefined;
  if (key === "Home" || (key === "ArrowDown" && currentIndex === -1)) {
    nextTarget = enabledItems[0];
  } else if (key === "End" || (key === "ArrowUp" && currentIndex === -1)) {
    nextTarget = enabledItems[enabledItems.length - 1];
  } else {
    const delta = key === "ArrowDown" ? 1 : -1;
    nextTarget = enabledItems[(currentIndex + delta + enabledItems.length) % enabledItems.length];
  }
  nextTarget?.focus();
  return true;
}

export function mountThreadMenu(
  actions: readonly ThreadMenuAction[],
  parent: Element,
  x: number,
  y: number,
) {
  let element!: HTMLDivElement;
  let firstButton: HTMLButtonElement | undefined;
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
            {({ label, ariaLabel, disabled, tooltip, className, onClick }) => {
              let labelElement: HTMLSpanElement | undefined;
              const button = (
                <button
                  ref={(node) => {
                    if (!disabled && !firstButton) {
                      firstButton = node;
                    }
                  }}
                  type="button"
                  role="menuitem"
                  aria-label={ariaLabel}
                  disabled={disabled}
                  onClick={(event) => onClick(event, labelElement)}
                >
                  {tooltip ? (
                    <span ref={(node) => (labelElement = node)} data-copy-label="">
                      {label}
                    </span>
                  ) : (
                    label
                  )}
                </button>
              );
              return tooltip ? (
                <openclaw-tooltip prop:content={tooltip} class={className}>
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
  return { element, dispose, firstButton };
}
