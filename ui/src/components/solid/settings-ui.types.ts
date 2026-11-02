export type SettingsToggleControl = {
  checked: boolean;
  disabled?: boolean;
  /** Block activation during a save without removing keyboard focus. Native disabled wins. */
  saving?: boolean;
  onChange: (checked: boolean) => boolean | void;
  onAct?: (checked: boolean) => void;
};

export type SettingsSegmentedProps<T extends string, Label> = {
  value: T;
  options: ReadonlyArray<{
    value: T;
    label: Label;
    title?: string;
    testId?: string;
    disabled?: boolean;
    compactLabel?: string;
    ariaLabel?: string;
  }>;
  inputRef?: (value: T, element: HTMLInputElement) => void;
  disabled?: boolean;
  /** Block activation during a save without removing keyboard focus. Native disabled wins. */
  saving?: boolean;
  ariaLabel?: string;
  descriptionId?: string;
  class?: string;
} & (
  | {
      mode?: undefined;
      ariaRequired?: boolean;
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
