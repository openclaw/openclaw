import { html, nothing } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { renderChannelPicker } from "../../components/channel-picker.ts";
import { renderPicker, type PickerOption } from "../../components/select-picker.ts";
import { renderSettingsToggleRow } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import type { CronFieldErrors, CronFieldKey, CronFormState } from "../../lib/cron/types.ts";
import { resolveScrollBehavior } from "../../lib/scroll-behavior.ts";
import type { CronProps } from "./view-types.ts";

type BlockingField = {
  label: string;
  message: string;
  inputId: string;
};

const CRON_FIELD_LABEL_KEYS: Record<CronFieldKey, string> = {
  name: "cron.form.fieldName",
  eventServer: "cron.events.server",
  eventName: "cron.events.name",
  eventArguments: "cron.events.arguments",
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
  // SAFETY: this module-owned literal contains exactly the exhaustive CronFieldKey mapping.
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

function renderFieldError(message?: string, id?: string) {
  if (!message) {
    return nothing;
  }
  return html`<div id=${ifDefined(id)} class="cron-help cron-error">${t(message)}</div>`;
}

function renderRequiredTitle(label: string) {
  return html`
    ${label}
    <span class="cron-required-marker" aria-hidden="true">*</span>
    <span class="cron-required-sr">${t("cron.form.requiredSr")}</span>
  `;
}

// Settings row whose control keeps its own validation message underneath. Mirrors
// renderSettingsRow markup; local only so the title can be a real <label for> that gives the
// wrapped control its accessible name (including the visually-hidden required marker).
export function renderFieldRow(params: {
  label: string;
  // Blank when the control is not labelable (e.g. a code block); the label then
  // has no `for` target and the control carries its own aria-label.
  controlId: string;
  control: unknown;
  required?: boolean;
  help?: string;
  error?: string;
  errorId?: string;
  stacked?: boolean;
  wide?: boolean;
}) {
  const controlClass = params.wide ? "cron-control cron-control--wide" : "cron-control";
  const control = html`<div class=${controlClass}>
    ${params.control}${renderFieldError(params.error, params.errorId)}
  </div>`;
  return html`
    <div class=${params.stacked ? "settings-row settings-row--stacked" : "settings-row"}>
      <label class="settings-row__text" for=${ifDefined(params.controlId || undefined)}>
        <span class="settings-row__title">
          ${params.required ? renderRequiredTitle(params.label) : params.label}
        </span>
        ${params.help ? html`<span class="settings-row__desc">${params.help}</span>` : nothing}
      </label>
      <div class="settings-row__control">${control}</div>
    </div>
  `;
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

export function renderCronInput(
  props: CronProps,
  field: CronStringFormField,
  options: CronInputOptions,
) {
  const error = options.errorKey ? props.fieldErrors[options.errorKey] : undefined;
  const describedBy =
    error && options.errorKey && options.describeError !== false
      ? errorIdForField(options.errorKey)
      : undefined;
  const control = html`
    <input
      id=${inputIdForField(field)}
      class=${options.mono ? "settings-input mono" : "settings-input"}
      type=${ifDefined(options.type)}
      aria-required=${ifDefined(options.required ? "true" : undefined)}
      .value=${props.form[field]}
      list=${ifDefined(options.list)}
      ?disabled=${options.disabled ?? false}
      aria-invalid=${ifDefined(options.errorKey ? (error ? "true" : "false") : undefined)}
      aria-describedby=${ifDefined(describedBy)}
      placeholder=${ifDefined(options.placeholder)}
      @input=${(event: Event) => {
        if (event.currentTarget instanceof HTMLInputElement) {
          props.onFormChange({ [field]: event.currentTarget.value });
        }
      }}
    />
  `;
  return options.inline
    ? control
    : renderFieldRow({
        label: options.label,
        controlId: inputIdForField(field),
        required: options.required,
        help: options.help,
        error,
        errorId: options.errorKey ? errorIdForField(options.errorKey) : undefined,
        control,
      });
}

type CronSelectOptions = {
  label: string;
  required?: boolean;
  options: readonly PickerOption[];
  help?: string;
  value?: string;
  disabled?: boolean;
  inline?: boolean;
  channel?: boolean;
  errorKey?: CronFieldKey;
};

export function renderCronSelect(
  props: CronProps,
  field: CronStringFormField,
  options: CronSelectOptions,
) {
  const selected = options.value ?? props.form[field];
  const error = options.errorKey ? props.fieldErrors[options.errorKey] : undefined;
  const picker = options.channel ? renderChannelPicker : renderPicker;
  const control = picker({
    id: options.inline ? undefined : inputIdForField(field),
    label: options.label,
    value: options.channel ? selected || "last" : selected,
    options: options.options,
    disabled: options.disabled,
    invalid: options.errorKey ? Boolean(error) : undefined,
    describedBy: error && options.errorKey ? errorIdForField(options.errorKey) : undefined,
    onChange: (value) => props.onFormChange({ [field]: value }),
  });
  return options.inline
    ? control
    : renderFieldRow({
        label: options.label,
        controlId: inputIdForField(field),
        help: options.help,
        required: options.required,
        error,
        errorId: options.errorKey ? errorIdForField(options.errorKey) : undefined,
        control,
      });
}

export function renderToggleRow(
  props: CronProps,
  field: CronBooleanFormField,
  params: { label: string; help?: string },
) {
  return renderSettingsToggleRow({
    title: params.label,
    description: params.help,
    checked: props.form[field],
    onChange: (checked) => props.onFormChange({ [field]: checked }),
  });
}
