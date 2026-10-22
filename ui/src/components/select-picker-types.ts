import type { JSX } from "@solidjs/web";

export type PickerOption = {
  value: string;
  label: string;
  description?: string;
  labelStyle?: string;
  disabled?: boolean;
};

export type PickerGroup = { id: string; label: string; leading?: JSX.Element };
export type PickerFocusHandle = {
  trigger: HTMLButtonElement;
  elements(): readonly HTMLElement[];
};
export type PickerParams<Option extends PickerOption> = {
  id?: string;
  label: string;
  value: string | null;
  options: readonly Option[];
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  className?: string;
  title?: string;
  placement?: "top" | "bottom";
  variant?: "submenu";
  /** Show the choices as a page of the enclosing sheet instead of a floating popup. */
  sheet?: boolean;
  /** `true` searches long lists; `"always"` keeps the field for short lists too. */
  searchable?: boolean | "always";
  searchPlaceholder?: string;
  groupBy?: (option: Option) => PickerGroup | undefined;
  showOptionTooltips?: boolean;
  showSelectedDescription?: boolean;
  onOpen?: () => void;
  /** Exposes this mounted picker's controls to an enclosing focus boundary. */
  focusRef?: (handle: PickerFocusHandle) => void;
  onChange: (value: string) => void;
  onChangeTarget?: (value: string, select: HTMLElement) => void;
  renderLeading?: (option: Option) => JSX.Element;
};
