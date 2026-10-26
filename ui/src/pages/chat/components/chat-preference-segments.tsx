import { For, createMemo } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { t } from "../../../lib/reactive/i18n.ts";

type PreferenceOption<T extends string> = { value: T; label: string; disabled?: boolean };

/** Shared Speed/Access radio behavior; the session preference remains the caller's state. */
export function ChatPreferenceSegments<T extends string>(props: {
  kind: "speed" | "access";
  label: string;
  options: readonly PreferenceOption<T>[];
  selected?: string;
  disabled: boolean;
  onSelect: (value: T) => void;
}) {
  const buttons = new Set<HTMLButtonElement>();
  const tabbableIndex = createMemo(() => {
    const selected = props.options.findIndex(
      (option) => option.value === props.selected && !option.disabled,
    );
    return selected >= 0 ? selected : props.options.findIndex((option) => !option.disabled);
  });
  const onKeyDown = (event: KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      return;
    }
    const options = [...buttons]
      .filter((button) => !button.disabled)
      .toSorted((left, right) =>
        left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
      );
    if (options.length === 0) {
      return;
    }
    const current = options.findIndex((option) => option === document.activeElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? options.length - 1
          : (current + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1) + options.length) %
            options.length;
    event.preventDefault();
    options[next]?.focus();
    options[next]?.click();
  };
  return (
    <div
      class={[
        "chat-controls__speed-options",
        { "chat-controls__speed-options--plain": props.kind === "speed" },
      ]}
      data-chat-access-program={props.kind === "access" ? "true" : undefined}
      role="radiogroup"
      aria-label={props.label}
      onKeyDown={onKeyDown}
    >
      <For each={props.options} keyed={(option) => option.value}>
        {(option, index) => {
          return (
            <button
              ref={elementRef<HTMLButtonElement>((element) => {
                buttons.add(element);
                return () => buttons.delete(element);
              })}
              type="button"
              role="radio"
              class="chat-controls__speed-option"
              data-chat-speed-option={props.kind === "speed" ? option().value : undefined}
              data-chat-access-option={props.kind === "access" ? option().value : undefined}
              aria-checked={option().value === props.selected ? "true" : "false"}
              tabindex={index() === tabbableIndex() ? 0 : -1}
              disabled={props.disabled || option().disabled}
              title={
                props.kind === "speed" && option().value === "ultrafast" && option().disabled
                  ? t("chat.modelControls.ultrafastUnavailable")
                  : undefined
              }
              onClick={(event: MouseEvent) => {
                event.stopPropagation();
                if (!props.disabled && !option().disabled) {
                  props.onSelect(option().value);
                }
              }}
            >
              {props.kind === "speed" && ["on", "ultrafast"].includes(option().value) && (
                <span class="chat-controls__speed-option-icon" aria-hidden="true">
                  <Icon name={option().value === "ultrafast" ? "zapDouble" : "zap"} />
                </span>
              )}
              {option().label}
            </button>
          );
        }}
      </For>
    </div>
  );
}
