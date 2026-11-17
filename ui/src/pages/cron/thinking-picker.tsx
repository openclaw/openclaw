import { createMemo, createSignal, onSettled, Show } from "solid-js";
import type { PickerOption } from "../../components/select-picker.ts";
import { Picker } from "../../components/solid/select-picker.tsx";
import { t } from "../../lib/reactive/i18n.ts";

export function CronThinkingPicker(props: {
  value: string;
  options: readonly PickerOption[];
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  const [custom, setCustom] = createSignal(false);
  let input: HTMLInputElement | undefined;
  const customValue = createMemo(() => {
    let value = "__custom_thinking__";
    while (value === props.value || props.options.some((option) => option.value === value)) {
      value += "_";
    }
    return value;
  });
  const options = createMemo(() => [
    { value: "", label: t("cron.form.defaultThinking") },
    ...props.options,
    ...(props.value && !props.options.some((option) => option.value === props.value)
      ? [{ value: props.value, label: props.value }]
      : []),
    { value: customValue(), label: t("cron.form.customThinking") },
  ]);
  return (
    <div style={{ display: "grid", gap: "var(--space-2)" }}>
      <Picker
        id={custom() ? "cron-payload-thinking-picker" : "cron-payload-thinking"}
        label={t("cron.form.thinking")}
        value={custom() ? customValue() : props.value}
        options={options()}
        invalid={props.invalid}
        describedBy={props.invalid ? "cron-error-payloadThinking" : undefined}
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
      <Show when={custom()}>
        <input
          ref={(element) => (input = element)}
          id="cron-payload-thinking"
          class="settings-input"
          aria-label={t("cron.form.customThinking")}
          aria-invalid={props.invalid ? "true" : undefined}
          aria-describedby={props.invalid ? "cron-error-payloadThinking" : undefined}
          value={props.value}
          onInput={(event) => props.onChange(event.currentTarget.value)}
        />
      </Show>
    </div>
  );
}
