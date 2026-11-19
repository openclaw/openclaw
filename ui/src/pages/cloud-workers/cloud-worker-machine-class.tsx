import { createMemo, createSignal, onSettled, Show } from "solid-js";
import type { PickerOption } from "../../components/select-picker.ts";
import { Picker } from "../../components/solid/select-picker.tsx";
import { t } from "../../lib/reactive/i18n.ts";

export function CloudWorkerMachineClass(props: {
  value: string;
  options: readonly PickerOption[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [custom, setCustom] = createSignal(false);
  let input: HTMLInputElement | undefined;
  const customValue = createMemo(() => {
    let value = "__custom_class__";
    while (value === props.value || props.options.some((option) => option.value === value)) {
      value += "_";
    }
    return value;
  });
  const options = createMemo(() => [
    ...props.options,
    ...(!props.options.some((option) => option.value === props.value)
      ? [{ value: props.value, label: props.value }]
      : []),
    { value: customValue(), label: t("cloudWorkersPage.fields.customMachineClass") },
  ]);
  return (
    <div style={{ display: "grid", gap: "var(--space-2)" }}>
      <Show when={props.options.length > 0}>
        <Picker
          id="cloud-worker-machine-class"
          label={t("cloudWorkersPage.fields.machineClass")}
          value={custom() ? customValue() : props.value}
          options={options()}
          disabled={props.disabled}
          onChange={(value) => {
            if (value === customValue()) {
              setCustom(true);
              onSettled(() => {
                input?.focus();
                input?.select();
              });
            } else {
              setCustom(false);
              props.onChange(value);
            }
          }}
        />
      </Show>
      <Show when={custom() || props.options.length === 0}>
        <input
          ref={(element) => (input = element)}
          class="settings-input mono"
          aria-label={t("cloudWorkersPage.fields.machineClass")}
          autocomplete="off"
          spellcheck="false"
          value={props.value}
          disabled={props.disabled}
          onInput={(event) => {
            setCustom(true);
            props.onChange(event.currentTarget.value);
          }}
        />
      </Show>
    </div>
  );
}
