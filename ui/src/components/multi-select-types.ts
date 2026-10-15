import type { ModelPickerOption } from "./model-picker.ts";

export type MultiSelectOption = ModelPickerOption;

export type MultiSelectProps = {
  options: readonly MultiSelectOption[];
  /** Current values in display order. Controlled: the host owns them. */
  value: readonly string[];
  isExcluded: (value: string) => boolean;
  /** The caller owns value identity; search remains case-insensitive. */
  getValueKey: (value: string) => string;
  placeholder: string;
  accessibleLabel: string;
  allowCustom: boolean;
  disabled: boolean;
  onChange: (value: string[]) => void;
  onOpen: () => void;
};
