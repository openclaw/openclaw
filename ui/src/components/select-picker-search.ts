/** The list stays the combobox's popup while the search field lives in the header. */
export function pickerSearchInputProps(state: {
  controls: string;
  invalid?: boolean;
  describedBy?: string;
  active?: string;
}) {
  return {
    role: "combobox",
    "data-picker-focus": "",
    "data-search": "",
    tabindex: "0",
    "aria-autocomplete": "list",
    "aria-expanded": "true",
    "aria-controls": state.controls,
    "aria-invalid": state.invalid ? "true" : undefined,
    "aria-describedby": state.describedBy,
    "aria-activedescendant": state.active,
  } as const;
}
