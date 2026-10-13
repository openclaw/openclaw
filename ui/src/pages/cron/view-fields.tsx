import type { JSX } from "@solidjs/web";
import { renderChannelPicker } from "../../components/channel-picker.ts";
import { renderPicker, type PickerOption } from "../../components/select-picker.ts";
import { SettingsToggleRow } from "../../components/solid/settings-ui.tsx";
import type { CronFieldKey, CronFormState, CronFieldErrors } from "../../lib/cron/types.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { resolveScrollBehavior } from "../../lib/scroll-behavior.ts";
import { LitContent } from "../../lit/solid-bridge.ts";
import type { CronProps } from "./view-types.ts";
type BlockingField = {
  label: string;
  message: string;
  inputId: string;
};
const CRON_FIELD_LABEL_KEYS: Record<CronFieldKey, string> = {
  name: "cron.form.fieldName",
  scheduleAt: "cron.form.runAt",
  everyAmount: "cron.form.every",
  cronExpr: "cron.form.expression",
  staggerAmount: "cron.form.staggerWindow",
  triggerScript: "cron.form.triggerScript",
  payloadText: "cron.form.assistantTaskPrompt",
  payloadModel: "cron.form.model",
  payloadThinking: "cron.form.thinking",
  timeoutSeconds: "cron.form.timeoutSeconds",
  deliveryMode: "cron.form.deliveryModeLabel",
  deliveryTo: "cron.form.to",
  failureAlertAfter: "cron.form.failureAlertAfter",
  failureAlertCooldownSeconds: "cron.form.failureAlertCooldown",
};
export function errorIdForField(props: CronFieldKey) {
  return `cron-error-${props}`;
}
export function inputIdForField(key: string) {
  return `cron-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}
export function collectBlockingFields(
  errors: CronFieldErrors,
  form: CronFormState,
  deliveryMode: CronFormState["deliveryMode"],
): BlockingField[] {
  // SAFETY: This complete Record<CronFieldKey, string> contains only the validated form field keys.
  return (Object.keys(CRON_FIELD_LABEL_KEYS) as CronFieldKey[]).flatMap((key) => {
    const message = errors[key];
    return message
      ? [
          {
            label: t(
              key === "payloadText" && form.payloadKind === "systemEvent"
                ? "cron.form.mainTimelineMessage"
                : key === "deliveryTo" && deliveryMode === "webhook"
                  ? "cron.form.webhookUrl"
                  : CRON_FIELD_LABEL_KEYS[key],
            ),
            message,
            inputId: inputIdForField(key),
          },
        ]
      : [];
  });
}
export function focusFormField(props: string) {
  const el = document.getElementById(props);
  if (!(el instanceof HTMLElement)) {
    return;
  }
  el.scrollIntoView?.({ block: "center", behavior: resolveScrollBehavior() });
  el.focus();
}
// A real label keeps the required marker in the control's accessible name.
export function FieldRow(props: {
  label: string;
  controlId: string;
  control: JSX.Element;
  required?: boolean;
  help?: string;
  error?: string;
  errorId?: string;
  stacked?: boolean;
  wide?: boolean;
  inline?: boolean;
}) {
  return (
    <>
      {" "}
      {props.inline ? (
        props.control
      ) : (
        <div class={["settings-row", { "settings-row--stacked": props.stacked }]}>
          <label class="settings-row__text" for={props.controlId || undefined}>
            <span class="settings-row__title">
              {props.label}
              {props.required ? (
                <>
                  <span class="cron-required-marker" aria-hidden="true">
                    *
                  </span>
                  <span class="cron-required-sr">{t("cron.form.requiredSr")}</span>
                </>
              ) : undefined}
            </span>
            {props.help ? <span class="settings-row__desc">{props.help}</span> : undefined}
          </label>
          <div class="settings-row__control">
            <div class={["cron-control", { "cron-control--wide": props.wide }]}>
              {props.control}
              {props.error ? (
                <div id={props.errorId} class="cron-help cron-error">
                  {t(props.error)}
                </div>
              ) : undefined}
            </div>
          </div>
        </div>
      )}{" "}
    </>
  );
}
type CronStringFormField = {
  [Field in keyof CronFormState]: CronFormState[Field] extends string ? Field : never;
}[keyof CronFormState];
type CronBooleanFormField = {
  [Field in keyof CronFormState]: CronFormState[Field] extends boolean ? Field : never;
}[keyof CronFormState];
type FormProps = Pick<CronProps, "form" | "fieldErrors" | "onFormChange">;
type CronInputOptions = {
  field: CronStringFormField;
  label: string;
  help?: string;
  placeholder?: string;
  list?: string;
  type?: string;
  required?: boolean;
  disabled?: boolean;
  mono?: boolean;
  errorKey?: CronFieldKey;
  describeError?: boolean;
  inline?: boolean;
};
export function CronInput(props: FormProps & CronInputOptions) {
  const error = () => (props.errorKey ? props.fieldErrors[props.errorKey] : undefined);
  const describedBy = () =>
    error() && props.errorKey && props.describeError !== false
      ? errorIdForField(props.errorKey)
      : undefined;
  const control = (
    <input
      id={inputIdForField(props.field)}
      class={props.mono ? "settings-input mono" : "settings-input"}
      type={props.type}
      aria-required={props.required ? "true" : undefined}
      value={props.form[props.field]}
      list={props.list}
      disabled={props.disabled ?? false}
      aria-invalid={props.errorKey ? (error() ? "true" : "false") : undefined}
      aria-describedby={describedBy()}
      placeholder={props.placeholder}
      onInput={(event) =>
        props.onFormChange({
          [props.field]: event.currentTarget.value,
        })
      }
    />
  );
  return (
    <FieldRow
      inline={props.inline}
      label={props.label}
      controlId={inputIdForField(props.field)}
      required={props.required}
      help={props.help}
      error={error()}
      errorId={props.errorKey ? errorIdForField(props.errorKey) : undefined}
      control={control}
    />
  );
}
type CronSelectOptions = {
  field: CronStringFormField;
  label: string;
  options: readonly PickerOption[];
  help?: string;
  value?: string;
  disabled?: boolean;
  inline?: boolean;
  channel?: boolean;
  errorKey?: CronFieldKey;
};
export function CronSelect(props: FormProps & CronSelectOptions) {
  const selected = () => props.value ?? props.form[props.field];
  const error = () => (props.errorKey ? props.fieldErrors[props.errorKey] : undefined);
  const control = (
    <LitContent
      render={() =>
        (props.channel ? renderChannelPicker : renderPicker)({
          id: props.inline ? undefined : inputIdForField(props.field),
          label: props.label,
          value: props.channel ? selected() || "last" : selected(),
          options: props.options,
          disabled: props.disabled,
          invalid: props.errorKey ? Boolean(error()) : undefined,
          describedBy: error() && props.errorKey ? errorIdForField(props.errorKey) : undefined,
          onChange: (value) => props.onFormChange({ [props.field]: value }),
        })
      }
    />
  );
  return (
    <FieldRow
      inline={props.inline}
      label={props.label}
      controlId={inputIdForField(props.field)}
      help={props.help}
      error={error()}
      errorId={props.errorKey ? errorIdForField(props.errorKey) : undefined}
      control={control}
    />
  );
}
export function ToggleRow(
  props: FormProps & {
    field: CronBooleanFormField;
    label: string;
    help?: string;
  },
) {
  return (
    <SettingsToggleRow
      title={props.label}
      description={props.help}
      checked={props.form[props.field]}
      onChange={(checked) => props.onFormChange({ [props.field]: checked })}
    />
  );
}
