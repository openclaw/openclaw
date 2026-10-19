import { Portal, render } from "@solidjs/web";
import { t } from "../../../i18n/index.ts";

export type ThreadMenuAction = {
  label: string;
  ariaLabel?: string;
  disabled?: boolean;
  tooltip?: string;
  className?: string;
  onClick: (event: Event, label?: HTMLSpanElement) => void;
};

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
          {actions.map(({ label, ariaLabel, disabled, tooltip, className, onClick }) => {
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
                  <span ref={(element) => (labelElement = element)} data-copy-label="">
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
          })}
        </div>
      </Portal>
    ),
    document.createElement("div"),
  );
  return { element, dispose, firstButton };
}
