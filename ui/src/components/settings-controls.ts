export type SettingsToggleControl = {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => boolean | void;
  onAct?: (checked: boolean) => void;
};

type SettingsSegmentedOption<T extends string, Label> = {
  value: T;
  label: Label;
  title?: string;
  testId?: string;
  disabled?: boolean;
  compactLabel?: string;
  ariaLabel?: string;
};

export type SettingsSegmentedProps<T extends string, Label> = {
  value: T;
  options: ReadonlyArray<SettingsSegmentedOption<T, Label>>;
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
      ariaPressed?: false;
      onClick?: (event: MouseEvent, value: T) => void;
      onChange: (value: T) => void;
      onReselect?: (value: T) => void;
    }
);

let radioId = 0;
export const nextSettingsRadioName = () => `settings-radio-${++radioId}`;

export function settingsSwitchClick(event: MouseEvent, props: SettingsToggleControl) {
  // SAFETY: Both renderers bind this listener directly to the native switch input.
  const input = event.currentTarget as HTMLInputElement;
  if (!input.matches(":disabled") && !props.disabled && input.checked !== props.checked) {
    props.onAct?.(input.checked);
  }
}

export function settingsSwitchChange(event: Event, props: SettingsToggleControl) {
  // SAFETY: Both renderers bind this listener directly to the native switch input.
  const input = event.currentTarget as HTMLInputElement;
  if (input.matches(":disabled") || props.disabled || props.onChange(input.checked) === false) {
    input.checked = props.checked;
  }
}

export function settingsSwitchKeyDown(event: KeyboardEvent, props: SettingsToggleControl) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
    return;
  }
  // SAFETY: Both renderers bind this listener directly to the native switch input.
  const input = event.currentTarget as HTMLInputElement;
  if (input.matches(":disabled") || props.disabled) {
    return;
  }
  event.preventDefault();
  const checked = (event.key === "ArrowRight") !== (getComputedStyle(input).direction === "rtl");
  if (checked === input.checked) {
    return;
  }
  input.checked = checked;
  props.onAct?.(checked);
  if (props.onChange(checked) === false) {
    input.checked = props.checked;
  }
}

export function settingsToggleRowClick(event: MouseEvent, props: SettingsToggleControl) {
  if (event.target instanceof Element && event.target.closest(".settings-toggle")) {
    return;
  }
  // SAFETY: Both renderers bind this listener directly to the settings row div.
  const input = (event.currentTarget as HTMLElement).querySelector<HTMLInputElement>(
    'input[role="switch"]',
  );
  if (!input || input.matches(":disabled") || props.disabled) {
    return;
  }
  input.click();
}

export function settingsRadioClick<T extends string, Label>(
  event: MouseEvent,
  value: T,
  props: SettingsSegmentedProps<T, Label>,
) {
  // SAFETY: Both renderers bind this listener directly to a native radio input.
  const input = event.currentTarget as HTMLInputElement;
  if (props.mode === "buttons" || props.disabled || input.matches(":disabled")) {
    return;
  }
  if (value === props.value) {
    props.onReselect?.(value, input.closest<HTMLElement>(".settings-segmented__btn") ?? input);
  }
}

export function settingsRadioChange<T extends string, Label>(
  event: Event,
  value: T,
  props: SettingsSegmentedProps<T, Label>,
) {
  // SAFETY: Both renderers bind this listener directly to a native radio input.
  const input = event.currentTarget as HTMLInputElement;
  if (props.mode === "buttons" || !input.checked) {
    return;
  }
  const group = input.closest('[role="radiogroup"]');
  if (
    props.disabled ||
    input.matches(":disabled") ||
    props.onChange(value, input.closest<HTMLElement>(".settings-segmented__btn") ?? input) === false
  ) {
    for (const radio of group?.querySelectorAll<HTMLInputElement>('input[type="radio"]') ?? []) {
      radio.checked = radio.value === props.value;
    }
  }
}

export function settingsRadioKeyDown(event: KeyboardEvent) {
  // SAFETY: Both renderers bind this listener directly to a native radio input.
  const input = event.currentTarget as HTMLInputElement;
  const group = input.closest('[role="radiogroup"]');
  if (!group || input.matches(":disabled")) {
    return;
  }
  const rtl = getComputedStyle(group).direction === "rtl";
  let step: number;
  switch (event.key) {
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
  const enabled = [...group.querySelectorAll<HTMLInputElement>('input[type="radio"]')].filter(
    (radio) => !radio.matches(":disabled"),
  );
  const index = enabled.indexOf(input);
  const next = enabled[(index + step + enabled.length) % enabled.length];
  next?.focus();
  next?.click();
}
