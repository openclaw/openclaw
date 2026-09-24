import { html, nothing, type TemplateResult } from "lit";
import { keyed } from "lit/directives/keyed.js";
import type { WizardStep } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { formatUiExternalText } from "../lib/format-error.ts";
import { renderChannelPicker } from "./channel-picker.ts";
import { handleCopyButton } from "./copy-button.ts";
import { renderPicker } from "./select-picker.ts";
import { renderSensitiveInput } from "./sensitive-input.ts";
import "../styles/wizard-step-controls.css";

type WizardStepOption = NonNullable<WizardStep["options"]>[number];

type WizardStepControlsProps = {
  step: WizardStep;
  /** Current draft answer; owned by the caller so it survives re-renders. */
  value: unknown;
  /** Disables every control while an answer is in flight. */
  busy: boolean;
  // The text step pairs `<label for>` with `<input id>`. The caller owns the id
  // so two step controls in one document cannot capture each other's label.
  inputId: string;
  validationErrorId?: string;
  onValueChange: (value: unknown) => void;
  onAnswer: (value: unknown) => void;
  presentation?: "channels";
  channelSelect?: boolean;
  answerLabel?: string;
  busyLabel?: string;
  confirmAffirmativeLabel?: string;
  leadingAction?: TemplateResult;
  externalAuthInput?: boolean;
  sensitiveRevealed?: boolean;
  onToggleSensitiveVisibility?: () => void;
};

export function renderWizardBusyButton(
  statusLabel: string,
  buttonLabel = t("modelSetup.wizard.continue"),
) {
  return html`
    <button type="button" class="btn primary" disabled aria-busy="true" aria-label=${buttonLabel}>
      <span class="btn__label">${buttonLabel}</span>
      <span class="btn__spinner" aria-hidden="true"></span>
      <span class="sr-only" role="status" aria-live="polite">${statusLabel}</span>
    </button>
  `;
}

function stepClass(props: WizardStepControlsProps, name: string): string {
  return `${props.presentation === "channels" ? "channels-wizard" : "wizard-step"}__${name}`;
}

function stepLabel(step: WizardStep): string {
  return step.message || step.title || t("chat.questions.answer");
}

function renderMessage(props: WizardStepControlsProps) {
  return props.step.message
    ? html`<div class=${stepClass(props, "message")}>
        ${formatUiExternalText(props.step.message)}
      </div>`
    : nothing;
}

function renderOptionBody(option: WizardStepOption, presentation?: "channels", selected?: boolean) {
  if (presentation === "channels") {
    return html`
      <span class="channels-wizard__option-label">
        ${selected === undefined ? nothing : selected ? "☑ " : "☐ "}${option.label}
      </span>
      ${
        option.hint
          ? html`<span class="channels-wizard__option-hint">${option.hint}</span>`
          : nothing
      }
    `;
  }
  return html`
    <span>
      <strong>${option.label}</strong>
      ${option.hint ? html`<small>${option.hint}</small>` : nothing}
    </span>
  `;
}

function renderSignIn(step: WizardStep) {
  // Authorization URLs are actions, not documents for inline readers or metadata fetches.
  const deviceCode = step.deviceCode;
  const copyLabel = t(deviceCode ? "modelSetup.wizard.copyCode" : "modelSetup.wizard.copyLink");
  const copyValue = deviceCode?.code ?? step.externalUrl;
  return html`
    <div class="wizard-step__sign-in">
      <p class="muted">${deviceCode?.message ?? t("modelSetup.wizard.browserInstructions")}</p>
      ${deviceCode ? html`<code class="wizard-step__sign-in-code">${deviceCode.code}</code>` : nothing}
      <div class="wizard-step__actions">
        ${step.externalUrl ? html`<a class="btn primary wizard-step__external-link" data-link-reader-external href=${step.externalUrl} target="_blank" rel="noreferrer">${t("modelSetup.wizard.openSignIn")}</a>` : nothing}
        ${copyValue ? keyed(copyValue, html`<button type="button" class="btn" @click=${(event: Event) => void handleCopyButton(event, copyValue, copyLabel)}><span data-copy-label>${copyLabel}</span></button>`) : nothing}
      </div>
      <div class="muted" role="status" aria-live="polite">${t("modelSetup.wizard.waiting")}</div>
      ${deviceCode?.expiresInMinutes ? html`<div class="muted">${t("modelSetup.wizard.expires", { count: String(deviceCode.expiresInMinutes) })}</div>` : nothing}
      ${deviceCode ? html`<p class="muted">${t("modelSetup.wizard.deviceCodeWarning")}</p>` : nothing}
    </div>
  `;
}

export function renderWizardSingleChoice(props: {
  options: WizardStepOption[];
  busy: boolean;
  label: string;
  value?: unknown;
  validationErrorId?: string;
  onAnswer: (value: unknown) => void;
}) {
  if (props.options.length <= 2) {
    return html`<div
      class="wizard-step__actions"
      role="group"
      aria-label=${props.label}
      aria-describedby=${props.validationErrorId ?? nothing}
    >
      ${props.options.map((option, index) => html`<button type="button" class=${index === 0 ? "btn primary" : "btn"} ?disabled=${props.busy} @click=${() => props.onAnswer(option.value)}>${renderOptionBody(option)}</button>`)}
    </div>`;
  }
  const selectedIndex = props.options.findIndex((option) => Object.is(option.value, props.value));
  return renderPicker({
    label: props.label,
    value: selectedIndex < 0 ? null : String(selectedIndex),
    options: props.options.map((option, index) => ({
      value: String(index),
      label: option.label,
      description: option.hint,
      kind: "neutral",
    })),
    disabled: props.busy,
    invalid: Boolean(props.validationErrorId),
    describedBy: props.validationErrorId,
    onChange: (value) => props.onAnswer(props.options[Number(value)]?.value),
  });
}

function renderAnswerButton(
  props: WizardStepControlsProps,
  label: string,
  onClick?: () => void,
  disabled = props.busy,
) {
  const buttonLabel = props.answerLabel ?? label;
  if (props.presentation === "channels" && props.busy) {
    return html`<div class="channels-wizard__footer">
      ${renderWizardBusyButton(props.busyLabel ?? buttonLabel)}
    </div>`;
  }
  const button = html`
    <button
      type=${onClick ? "button" : "submit"}
      class="btn primary"
      ?disabled=${disabled}
      @click=${onClick}
    >
      ${buttonLabel}
    </button>
  `;
  if (props.presentation === "channels") {
    return html`<div class="channels-wizard__footer">${button}</div>`;
  }
  return props.leadingAction
    ? html`<div class="wizard-step__actions wizard-step__actions--split">
        ${props.leadingAction}${button}
      </div>`
    : button;
}

function renderOption(
  props: WizardStepControlsProps,
  option: WizardStepOption,
  selected: unknown[],
) {
  const checked = selected.some((value) => Object.is(value, option.value));
  if (props.presentation === "channels") {
    return html`<button
      type="button"
      class="channels-wizard__option"
      aria-pressed=${checked ? "true" : "false"}
      ?disabled=${props.busy}
      aria-invalid=${props.validationErrorId ? "true" : nothing}
      aria-describedby=${props.validationErrorId ?? nothing}
      @click=${() => props.onValueChange(option.value)}
    >
      ${renderOptionBody(option, props.presentation, checked)}
    </button>`;
  }
  return html`<label class="wizard-step__option">
    <input
      type="checkbox"
      .checked=${checked}
      ?disabled=${props.busy}
      aria-invalid=${props.validationErrorId ? "true" : nothing}
      aria-describedby=${props.validationErrorId ?? nothing}
      @change=${(event: Event) => {
        const nextValue = (event.currentTarget as HTMLInputElement).checked
          ? [...selected, option.value]
          : selected.filter((value) => !Object.is(value, option.value));
        props.onValueChange(nextValue);
      }}
    />
    ${renderOptionBody(option)}
  </label>`;
}

function renderExternalStepInfo(step: WizardStep) {
  return step.externalUrl || step.deviceCode ? renderSignIn(step) : nothing;
}

function renderContinueStep(props: WizardStepControlsProps) {
  return html`
    ${renderMessage(props)} ${renderExternalStepInfo(props.step)}
    ${renderAnswerButton(props, t("modelSetup.wizard.continue"), () => props.onAnswer(undefined))}
  `;
}

function renderProgressStep(props: WizardStepControlsProps) {
  return html`
    ${
      props.step.externalUrl || props.step.deviceCode
        ? nothing
        : html`<div class="wizard-step__progress" role="status" aria-live="polite">
            <span class="wizard-step__spinner" aria-hidden="true"></span>
            ${renderMessage(props)}
          </div>`
    }
    ${renderExternalStepInfo(props.step)}
    ${
      props.leadingAction
        ? html`<div class="wizard-step__actions wizard-step__actions--split">
            ${props.leadingAction}
          </div>`
        : nothing
    }
  `;
}

function renderTextStep(props: WizardStepControlsProps) {
  const step = props.step;
  const value = typeof props.value === "string" ? props.value : "";
  const input =
    step.sensitive && props.onToggleSensitiveVisibility
      ? renderSensitiveInput({
          id: props.inputId,
          name: "wizard-text",
          value,
          revealed: props.sensitiveRevealed === true,
          revealLabel: t("configForm.revealValue"),
          hideLabel: t("configForm.hideValue"),
          inputClassName: "input",
          placeholder: step.placeholder,
          disabled: props.busy,
          invalid: Boolean(props.validationErrorId),
          describedBy: props.validationErrorId,
          label: step.message ? undefined : stepLabel(step),
          onInput: props.onValueChange,
          onToggle: props.onToggleSensitiveVisibility,
        })
      : html`<input
          id=${props.inputId}
          class="input"
          name="wizard-text"
          type=${step.sensitive ? "password" : "text"}
          autocomplete=${step.sensitive ? "off" : "on"}
          placeholder=${step.placeholder ?? ""}
          .value=${value}
          ?disabled=${props.busy}
          aria-invalid=${props.validationErrorId ? "true" : nothing}
          aria-describedby=${props.validationErrorId ?? nothing}
          aria-label=${step.message ? nothing : stepLabel(step)}
          @input=${(event: Event) =>
            props.presentation !== "channels" &&
            props.onValueChange((event.currentTarget as HTMLInputElement).value)}
        />`;
  const form = html`
    <form
      class="wizard-step__form"
      @submit=${(event: Event) => {
        event.preventDefault();
        const formInput = (event.currentTarget as HTMLFormElement).elements.namedItem(
          "wizard-text",
        ) as HTMLInputElement | null;
        props.onAnswer(props.presentation === "channels" ? (formInput?.value ?? "") : value);
      }}
    >
      ${
        step.message
          ? html`<div class=${stepClass(props, "message")}>
              <label for=${props.inputId}>${formatUiExternalText(step.message)}</label>
            </div>`
          : nothing
      }
      ${props.externalAuthInput ? nothing : renderExternalStepInfo(step)} ${input}
      ${renderAnswerButton(
        props.externalAuthInput ? { ...props, leadingAction: undefined } : props,
        t("modelSetup.wizard.submit"),
      )}
    </form>
  `;
  return props.externalAuthInput
    ? html`
        ${renderExternalStepInfo(step)}
        <details class="wizard-step__manual-entry">
          <summary class="muted">${t("modelSetup.wizard.manualEntry")}</summary>
          ${form}
        </details>
        <div class="wizard-step__actions wizard-step__actions--split">
          ${props.leadingAction ?? nothing}
        </div>
      `
    : form;
}

function renderOptionsStep(props: WizardStepControlsProps) {
  const options = props.step.options ?? [];
  const multiple = props.step.type === "multiselect";
  if (!multiple && props.presentation !== "channels") {
    return html`
      ${renderMessage(props)}
      ${renderWizardSingleChoice({ options, busy: props.busy, label: stepLabel(props.step), value: props.value, validationErrorId: props.validationErrorId, onAnswer: props.onAnswer })}
      ${props.leadingAction ?? nothing}
    `;
  }
  if (props.presentation === "channels" && !multiple) {
    const selectedIndex = options.findIndex((option) => Object.is(option.value, props.value));
    const channels =
      props.channelSelect && options.every((option) => typeof option.value === "string");
    const picker = channels ? renderChannelPicker : renderPicker;
    return html`
      ${renderMessage(props)}
      ${picker({
        label: stepLabel(props.step),
        value:
          selectedIndex < 0
            ? null
            : channels
              ? String(options[selectedIndex]?.value)
              : String(selectedIndex),
        options: options.map((option, index) => ({
          value: channels ? String(option.value) : String(index),
          label: option.label,
          description: option.hint,
          kind: channels ? "channel" : "neutral",
        })),
        disabled: props.busy,
        invalid: Boolean(props.validationErrorId),
        describedBy: props.validationErrorId,
        onChange: (value) => props.onAnswer(channels ? value : options[Number(value)]?.value),
      })}
      ${
        props.busy
          ? renderAnswerButton(props, t("modelSetup.wizard.continue"), undefined, true)
          : nothing
      }
    `;
  }
  const selected = Array.isArray(props.value) ? props.value : [];
  const answer = props.presentation === "channels" ? [...selected] : selected;
  return html`
    ${renderMessage(props)}
    <div
      class=${stepClass(props, "options")}
      role="group"
      aria-label=${stepLabel(props.step)}
      aria-describedby=${props.validationErrorId ?? nothing}
    >
      ${options.map((option) => renderOption(props, option, selected))}
    </div>
    ${renderAnswerButton(
      props,
      t("modelSetup.wizard.continue"),
      () => props.onAnswer(answer),
      props.busy,
    )}
  `;
}

function renderConfirmStep(props: WizardStepControlsProps) {
  const actionClass = stepClass(props, props.presentation === "channels" ? "footer" : "actions");
  return html`
    ${renderMessage(props)}
    <div
      class=${
        props.presentation !== "channels" && props.leadingAction
          ? `${actionClass} wizard-step__actions--split`
          : actionClass
      }
    >
      ${props.presentation === "channels" ? nothing : (props.leadingAction ?? nothing)}
      ${
        props.presentation === "channels" && props.busy
          ? renderWizardBusyButton(props.busyLabel ?? t("common.loading"))
          : [false, true].map(
              (answer) => html`<button
                type="button"
                class=${answer ? "btn primary" : "btn"}
                ?disabled=${props.busy}
                @click=${() => props.onAnswer(answer)}
              >
                ${answer ? (props.confirmAffirmativeLabel ?? t("common.yes")) : t("common.no")}
              </button>`,
            )
      }
    </div>
  `;
}

/**
 * Renders the interactive controls for one `WizardStep`. Container-agnostic on
 * purpose: no dialog chrome or page state — callers place the result wherever
 * the step is being asked (modal, panel, or chat bubble). A caller may supply a
 * leading action so escape and answer controls share one footer row.
 */
export function renderWizardStepControls(
  props: WizardStepControlsProps,
): TemplateResult | typeof nothing {
  switch (props.step.type) {
    case "text":
      return renderTextStep(props);
    case "select":
    case "multiselect":
      return renderOptionsStep(props);
    case "confirm":
      return renderConfirmStep(props);
    case "progress":
      return props.step.executor === "gateway"
        ? renderProgressStep(props)
        : renderContinueStep(props);
    // These show whatever the step supplies behind a single Continue.
    case "note":
    case "action":
      return renderContinueStep(props);
  }
  return nothing;
}
