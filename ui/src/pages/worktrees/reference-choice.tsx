import { createMemo, createSignal, onSettled, Show } from "solid-js";
import type { PickerOption } from "../../components/select-picker-types.ts";
import { Picker } from "../../components/solid/select-picker.tsx";

/** The creation model owns values; this field owns only custom-entry presentation. */
export function WorktreeReferenceChoice(props: {
  id: string;
  label: string;
  value: string;
  options: readonly PickerOption[];
  emptyLabel: string;
  customLabel: string;
  disabled: boolean;
  scope: string | number;
  onInput: (value: string) => void;
  onCommit?: () => void;
}) {
  let input: HTMLInputElement | undefined;
  const scope = createMemo(() => props.scope);
  const [custom, setCustom] = createSignal(() => {
    scope();
    return false;
  });
  const customValue = createMemo(() => {
    let value = "__custom_reference__";
    while (value === props.value || props.options.some((row) => row.value === value)) {
      value += "_";
    }
    return value;
  });
  const options = createMemo(() => [
    { value: "", label: props.emptyLabel },
    ...props.options,
    ...(props.value && !props.options.some((row) => row.value === props.value)
      ? [{ value: props.value, label: props.value }]
      : []),
    { value: customValue(), label: props.customLabel },
  ]);
  return (
    <>
      <Picker
        id={props.id}
        label={props.label}
        value={custom() ? customValue() : props.value}
        options={options()}
        searchable="always"
        disabled={props.disabled}
        showSelectedDescription
        onChange={(value) => {
          if (value === customValue()) {
            setCustom(true);
            onSettled(() => {
              input?.focus();
              input?.select();
            });
          } else {
            setCustom(false);
            props.onInput(value);
            props.onCommit?.();
          }
        }}
      />
      <Show when={custom()}>
        <input
          ref={(element) => (input = element)}
          class="settings-input"
          type="text"
          aria-label={props.customLabel}
          value={props.value}
          disabled={props.disabled}
          onInput={(event) => props.onInput(event.currentTarget.value)}
          onChange={() => props.onCommit?.()}
        />
      </Show>
    </>
  );
}
