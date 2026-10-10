import type { JSX } from "@solidjs/web";
import { createMemo } from "solid-js";
import type { PickerOption } from "../../components/select-picker.ts";
import { SettingsToggleRow } from "../../components/solid/settings-ui.tsx";
import type { CronFieldKey, CronFormState, CronFieldErrors } from "../../lib/cron/types.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { resolveScrollBehavior } from "../../lib/scroll-behavior.ts";
import { CronPicker } from "./view-controls.tsx";
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
export function errorIdForField(key: CronFieldKey) {
  return `cron-error-${key}`;
}
export function inputIdForField(key: string) {
  return `cron-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}
function fieldLabelForKey(
  key: CronFieldKey,
  form: CronFormState,
  deliveryMode: CronFormState["deliveryMode"],
) {
  if (key === "payloadText" && form.payloadKind === "systemEvent") {
    return t("cron.form.mainTimelineMessage");
  }
  if (key === "deliveryTo" && deliveryMode === "webhook") {
    return t("cron.form.webhookUrl");
  }
  return t(CRON_FIELD_LABEL_KEYS[key]);
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
            label: fieldLabelForKey(key, form, deliveryMode),
            message,
            inputId: inputIdForField(key),
          },
        ]
      : [];
  });
}
export function focusFormField(id: string) {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLElement)) {
    return;
  }
  if (typeof el.scrollIntoView === "function") {
    el.scrollIntoView({ block: "center", behavior: resolveScrollBehavior() });
  }
  el.focus();
}
function FieldError(props: { message?: string; id?: string }) {
  return (
    <>
      {props.message ? (
        <div id={props.id} class="cron-help cron-error">
          {t(props.message)}
        </div>
      ) : undefined}
    </>
  );
}
function RequiredTitle(componentProps: { label: string }) {
  return (
    <>
      {componentProps.label}
      <span class="cron-required-marker" aria-hidden="true">
        *
      </span>
      <span class="cron-required-sr">{t("cron.form.requiredSr")}</span>
    </>
  );
}
// Settings row whose control keeps its own validation message underneath. Mirrors
// SettingsRow markup; local only so the title can be a real <label for> that gives the
// wrapped control its accessible name (including the visually-hidden required marker).
export function FieldRow(componentProps: {
  params: {
    label: string;
    // Blank when the control is not labelable (e.g. a code block); the label then
    // has no `for` target and the control carries its own aria-label.
    controlId: string;
    control: JSX.Element;
    required?: boolean;
    help?: string;
    error?: string;
    errorId?: string;
    stacked?: boolean;
    wide?: boolean;
  };
}) {
  const controlClass = createMemo(() =>
    componentProps.params.wide ? "cron-control cron-control--wide" : "cron-control",
  );
  const control = (
    <div class={controlClass()}>
      {componentProps.params.control}
      <FieldError message={componentProps.params.error} id={componentProps.params.errorId} />
    </div>
  );
  return (
    <div
      class={componentProps.params.stacked ? "settings-row settings-row--stacked" : "settings-row"}
    >
      <label class="settings-row__text" for={componentProps.params.controlId || undefined}>
        <span class="settings-row__title">
          {componentProps.params.required ? (
            <RequiredTitle label={componentProps.params.label} />
          ) : (
            componentProps.params.label
          )}
        </span>
        {componentProps.params.help ? (
          <span class="settings-row__desc">{componentProps.params.help}</span>
        ) : undefined}
      </label>
      <div class="settings-row__control">{control}</div>
    </div>
  );
}
type CronStringFormField = {
  [Field in keyof CronFormState]: CronFormState[Field] extends string ? Field : never;
}[keyof CronFormState];
type CronBooleanFormField = {
  [Field in keyof CronFormState]: CronFormState[Field] extends boolean ? Field : never;
}[keyof CronFormState];
type CronInputOptions = {
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
export function CronInput(componentProps: {
  props: CronProps;
  field: CronStringFormField;
  options: CronInputOptions;
}) {
  const error = createMemo(() =>
    componentProps.options.errorKey
      ? componentProps.props.fieldErrors[componentProps.options.errorKey]
      : undefined,
  );
  const describedBy = createMemo(() =>
    error() && componentProps.options.errorKey && componentProps.options.describeError !== false
      ? errorIdForField(componentProps.options.errorKey)
      : undefined,
  );
  const control = (
    <input
      id={inputIdForField(componentProps.field)}
      class={componentProps.options.mono ? "settings-input mono" : "settings-input"}
      type={componentProps.options.type}
      aria-required={componentProps.options.required ? "true" : undefined}
      prop:value={componentProps.props.form[componentProps.field]}
      list={componentProps.options.list}
      disabled={componentProps.options.disabled ?? false}
      aria-invalid={componentProps.options.errorKey ? (error() ? "true" : "false") : undefined}
      aria-describedby={describedBy()}
      placeholder={componentProps.options.placeholder}
      onInput={(event) =>
        componentProps.props.onFormChange({
          [componentProps.field]: event.currentTarget.value,
        })
      }
    />
  );
  return createMemo(() =>
    componentProps.options.inline ? (
      control
    ) : (
      <FieldRow
        params={{
          label: componentProps.options.label,
          controlId: inputIdForField(componentProps.field),
          required: componentProps.options.required,
          help: componentProps.options.help,
          error: error(),
          errorId: componentProps.options.errorKey
            ? errorIdForField(componentProps.options.errorKey)
            : undefined,
          control,
        }}
      />
    ),
  );
}
type CronSelectOptions = {
  label: string;
  options: readonly PickerOption[];
  help?: string;
  value?: string;
  disabled?: boolean;
  inline?: boolean;
  channel?: boolean;
  errorKey?: CronFieldKey;
};
export function CronSelect(componentProps: {
  props: CronProps;
  field: CronStringFormField;
  options: CronSelectOptions;
}) {
  const selected = createMemo(
    () => componentProps.options.value ?? componentProps.props.form[componentProps.field],
  );
  const error = createMemo(() =>
    componentProps.options.errorKey
      ? componentProps.props.fieldErrors[componentProps.options.errorKey]
      : undefined,
  );
  const control = (
    <CronPicker
      params={{
        id: componentProps.options.inline ? undefined : inputIdForField(componentProps.field),
        label: componentProps.options.label,
        value: componentProps.options.channel ? selected() || "last" : selected(),
        options: componentProps.options.options,
        disabled: componentProps.options.disabled,
        invalid: componentProps.options.errorKey ? Boolean(error()) : undefined,
        describedBy:
          error() && componentProps.options.errorKey
            ? errorIdForField(componentProps.options.errorKey)
            : undefined,
        onChange: (value) => componentProps.props.onFormChange({ [componentProps.field]: value }),
      }}
      channel={componentProps.options.channel}
    />
  );
  return createMemo(() =>
    componentProps.options.inline ? (
      control
    ) : (
      <FieldRow
        params={{
          label: componentProps.options.label,
          controlId: inputIdForField(componentProps.field),
          help: componentProps.options.help,
          error: error(),
          errorId: componentProps.options.errorKey
            ? errorIdForField(componentProps.options.errorKey)
            : undefined,
          control,
        }}
      />
    ),
  );
}
export function ToggleRow(componentProps: {
  props: CronProps;
  field: CronBooleanFormField;
  params: {
    label: string;
    help?: string;
  };
}) {
  return (
    <SettingsToggleRow
      title={componentProps.params.label}
      description={componentProps.params.help}
      checked={componentProps.props.form[componentProps.field]}
      onChange={(checked) => componentProps.props.onFormChange({ [componentProps.field]: checked })}
    />
  );
}
