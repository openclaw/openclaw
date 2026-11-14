import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { createMemo, createSignal, onSettled, Show } from "solid-js";
import { Picker } from "../../components/solid/select-picker.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { FieldRow, errorIdForField, inputIdForField } from "./view-fields.tsx";
import type { CronProps } from "./view-types.ts";

export function CronTimezonePicker(
  props: Pick<
    CronProps,
    | "form"
    | "editingJob"
    | "onFormChange"
    | "fieldErrors"
    | "timezoneSuggestions"
    | "busy"
    | "canManage"
  > & {
    field: "cronTz" | "activeHoursTimezone";
  },
) {
  let input: HTMLInputElement | undefined;
  const scope = createMemo(() => [props.field, props.editingJob?.id] as const, {
    equals: (a, b) => a.every((value, index) => value === b[index]),
  });
  // Only custom-entry presentation resets between jobs; the form owns every value.
  const [custom, setCustom] = createSignal(() => {
    scope();
    return false;
  });
  const activeHours = () => props.field === "activeHoursTimezone";
  const selected = () => props.form[props.field].trim();
  const error = () => props.fieldErrors[props.field];
  const disabled = () => props.busy || !props.canManage;
  const zones = createMemo(() =>
    normalizeUniqueTrimmedStringList([selected(), ...props.timezoneSuggestions]),
  );
  const customValue = createMemo(() => {
    let value = "__custom_timezone__";
    while (zones().includes(value)) {
      value += "_";
    }
    return value;
  });
  const options = createMemo(() => [
    {
      value: "",
      label: t(
        activeHours() ? "cron.form.userTimezoneDefault" : "cron.form.gatewayTimezoneDefault",
      ),
    },
    ...(activeHours()
      ? [
          { value: "user", label: t("cron.form.userTimezone") },
          { value: "local", label: t("cron.form.gatewayTimezone") },
        ]
      : []),
    ...zones()
      .filter((value) => !activeHours() || (value !== "user" && value !== "local"))
      .map((value) => ({ value, label: value.replaceAll("_", " ") })),
    { value: customValue(), label: t("cron.form.enterTimezone") },
  ]);
  return (
    <FieldRow
      label={t("cron.form.timezoneOptional")}
      controlId={inputIdForField(props.field)}
      help={t(activeHours() ? "cron.form.activeHoursTimezoneHelp" : "cron.form.timezoneHelp")}
      error={error()}
      errorId={errorIdForField(props.field)}
      control={
        <>
          <Picker
            id={inputIdForField(props.field)}
            label={t("cron.form.timezoneOptional")}
            value={custom() ? customValue() : selected()}
            options={options()}
            searchable="always"
            disabled={disabled()}
            invalid={Boolean(error())}
            describedBy={error() ? errorIdForField(props.field) : undefined}
            onChange={(value) => {
              if (value === customValue()) {
                setCustom(true);
                onSettled(() => {
                  input?.focus();
                  input?.select();
                });
              } else {
                setCustom(false);
                props.onFormChange({ [props.field]: value });
              }
            }}
          />
          <Show when={custom()}>
            <input
              ref={(element) => (input = element)}
              class="settings-input"
              aria-label={t("cron.form.customTimezone")}
              aria-invalid={error() ? "true" : "false"}
              aria-describedby={error() ? errorIdForField(props.field) : undefined}
              value={props.form[props.field]}
              disabled={disabled()}
              onInput={(event) => props.onFormChange({ [props.field]: event.currentTarget.value })}
            />
          </Show>
        </>
      }
    />
  );
}
