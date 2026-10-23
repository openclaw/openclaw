import type { JSX } from "@solidjs/web";
import { For, onSettled, Show } from "solid-js";

type SettingsSegmentedOption<T extends string, Label> = {
  value: T;
  label: Label;
  title?: string;
  testId?: string;
  disabled?: boolean;
  compactLabel?: string;
  ariaLabel?: string;
  className?: JSX.HTMLAttributes<HTMLLabelElement>["class"];
};

export type SettingsSegmentedProps<T extends string, Label> = {
  value: T;
  options: ReadonlyArray<SettingsSegmentedOption<T, Label>>;
  inputRef?: (value: T, element: HTMLInputElement) => void;
  disabled?: boolean;
  ariaLabel?: string;
  descriptionId?: string;
  class?: string;
} & (
  | {
      mode?: undefined;
      onChange: (value: T, element: HTMLElement) => boolean | void;
      onReselect?: (value: T, element: HTMLElement) => void;
    }
  | {
      mode: "buttons";
      variant?: "accent" | "primary" | "compact";
      onClick?: (event: MouseEvent, value: T) => void;
      onChange: (value: T) => void;
      onReselect?: (value: T) => void;
    }
);

let radioId = 0;
export const nextSettingsRadioName = () => `settings-radio-${++radioId}`;

export function SettingsSegmented<T extends string>(props: SettingsSegmentedProps<T, JSX.Element>) {
  const name = nextSettingsRadioName();
  const inputs = new Map<string, HTMLInputElement>();
  const radios = () => props.options.flatMap((option) => inputs.get(option.value) ?? []);
  return (
    <Show
      when={props.mode === "buttons"}
      fallback={
        <div
          class={["settings-segmented", props.class]}
          role="radiogroup"
          aria-label={props.ariaLabel}
          aria-describedby={props.descriptionId}
          aria-orientation="horizontal"
        >
          <For each={props.options} keyed={(option) => option.value}>
            {(option) => {
              let inputElement: HTMLInputElement;
              onSettled(() => {
                const initialValue = option().value;
                inputs.set(initialValue, inputElement);
                props.inputRef?.(initialValue, inputElement);
                return () => inputs.delete(initialValue);
              });
              return (
                <label
                  class={[
                    "settings-segmented__btn",
                    option().className,
                    { "settings-segmented__btn--active": option().value === props.value },
                  ]}
                  title={option().title}
                  data-test-id={option().testId}
                >
                  <input
                    ref={(element) => (inputElement = element)}
                    class="settings-segmented__input"
                    type="radio"
                    name={name}
                    value={option().value}
                    checked={option().value === props.value}
                    disabled={props.disabled || option().disabled}
                    aria-label={option().ariaLabel}
                    onClick={(event) => {
                      const input = event.currentTarget;
                      if (
                        props.mode === "buttons" ||
                        props.disabled ||
                        input.matches(":disabled")
                      ) {
                        return;
                      }
                      if (option().value === props.value) {
                        props.onReselect?.(
                          option().value,
                          input.closest<HTMLElement>(".settings-segmented__btn") ?? input,
                        );
                      }
                    }}
                    onChange={(event) => {
                      const input = event.currentTarget;
                      if (props.mode === "buttons" || !input.checked) {
                        return;
                      }
                      if (
                        props.disabled ||
                        input.matches(":disabled") ||
                        props.onChange(
                          option().value,
                          input.closest<HTMLElement>(".settings-segmented__btn") ?? input,
                        ) === false
                      ) {
                        for (const radio of radios()) {
                          radio.checked = radio.value === props.value;
                        }
                      }
                    }}
                    onKeyDown={(event) => {
                      const input = event.currentTarget;
                      const group = input.closest('[role="radiogroup"]');
                      if (
                        !group ||
                        input.matches(":disabled") ||
                        event.altKey ||
                        event.ctrlKey ||
                        event.metaKey ||
                        event.isComposing
                      ) {
                        return;
                      }
                      const rtl = getComputedStyle(group).direction === "rtl";
                      let step = 0;
                      switch (event.key) {
                        case "Home":
                        case "End":
                          break;
                        case "ArrowRight":
                          step = rtl ? -1 : 1;
                          break;
                        case "ArrowLeft":
                          step = rtl ? 1 : -1;
                          break;
                        case "ArrowDown":
                          step = 1;
                          break;
                        case "ArrowUp":
                          step = -1;
                          break;
                        default:
                          return;
                      }
                      event.preventDefault();
                      const enabled = radios().filter((radio) => !radio.matches(":disabled"));
                      const index = enabled.indexOf(input);
                      const next =
                        enabled[
                          event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? enabled.length - 1
                              : (index + step + enabled.length) % enabled.length
                        ];
                      next?.focus();
                      next?.click();
                    }}
                  />
                  {option().label}
                </label>
              );
            }}
          </For>
        </div>
      }
    >
      <SettingsSegmentedButtons {...props} />
    </Show>
  );
}

function SettingsSegmentedButtons<T extends string>(props: SettingsSegmentedProps<T, JSX.Element>) {
  const variant = () => (props.mode === "buttons" ? props.variant : undefined);
  return (
    <div
      class={[
        "settings-segmented",
        props.class,
        { [`settings-segmented--${variant()}`]: Boolean(variant()) },
      ]}
      role={props.ariaLabel ? "group" : undefined}
      aria-label={props.ariaLabel}
    >
      <For each={props.options} keyed={(option) => option.value}>
        {(option) => (
          <button
            type="button"
            class={[
              "settings-segmented__btn",
              {
                "settings-segmented__btn--active": option().value === props.value,
                "btn btn--sm": variant() === "accent",
              },
            ]}
            aria-pressed={option().value === props.value ? "true" : "false"}
            aria-label={option().ariaLabel}
            data-compact-label={option().compactLabel}
            data-test-id={option().testId}
            title={option().title}
            disabled={props.disabled || option().disabled}
            onClick={(event) => {
              if (props.mode !== "buttons") {
                return;
              }
              props.onClick?.(event, option().value);
              if (event.defaultPrevented || props.disabled || option().disabled) {
                return;
              }
              if (option().value === props.value) {
                props.onReselect?.(option().value);
              } else {
                props.onChange(option().value);
              }
            }}
          >
            {option().label}
          </button>
        )}
      </For>
    </div>
  );
}
