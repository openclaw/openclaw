import type { JSX } from "@solidjs/web";
import { createMemo, For, Match, Show, Switch } from "solid-js";
import type { WizardStep } from "../../api/types.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { renderChannelIcon } from "../channel-icon.ts";
import { handleCopyButton } from "../copy-button-state.ts";
import type { PickerOption, PickerParams } from "../select-picker.ts";
import "../select-picker.ts";
import "../tooltip.ts";
import { Icon } from "./icon.tsx";
import "../../styles/wizard-step-controls.css";

type WizardStepOption = NonNullable<WizardStep["options"]>[number];

export type WizardStepControlsProps = {
  step: WizardStep;
  value: unknown;
  busy: boolean;
  inputId: string;
  validationErrorId?: string;
  onValueChange: (value: unknown) => void;
  onAnswer: (value: unknown) => void;
  presentation?: "channels";
  channelSelect?: boolean;
  answerLabel?: string;
  busyLabel?: string;
  confirmAffirmativeLabel?: string;
  leadingAction?: JSX.Element;
  externalAuthInput?: boolean;
  sensitiveRevealed?: boolean;
  onToggleSensitiveVisibility?: () => void;
};

export function renderWizardBusyButton(
  statusLabel: string,
  buttonLabel = t("modelSetup.wizard.continue"),
) {
  return (
    <button type="button" class="btn primary" disabled aria-busy="true" aria-label={buttonLabel}>
      <span class="btn__label">{buttonLabel}</span>
      <span class="btn__spinner" aria-hidden="true" />
      <span class="sr-only" role="status" aria-live="polite">
        {statusLabel}
      </span>
    </button>
  );
}

function stepClass(props: WizardStepControlsProps, name: string): string {
  return `${props.presentation === "channels" ? "channels-wizard" : "wizard-step"}__${name}`;
}

function stepLabel(step: WizardStep): string {
  return step.message || step.title || t("chat.questions.answer");
}

function Message(props: WizardStepControlsProps) {
  return (
    <>
      {props.step.message ? (
        <div class={stepClass(props, "message")}>{formatUiExternalText(props.step.message)}</div>
      ) : undefined}
    </>
  );
}

function OptionBody(props: {
  option: WizardStepOption;
  presentation?: "channels";
  selected?: boolean;
}) {
  return (
    <>
      {props.presentation === "channels" ? (
        <>
          <span class="channels-wizard__option-label">
            {props.selected === undefined ? undefined : props.selected ? "☑ " : "☐ "}
            {props.option.label}
          </span>
          {props.option.hint ? (
            <span class="channels-wizard__option-hint">{props.option.hint}</span>
          ) : undefined}
        </>
      ) : (
        <span>
          <strong>{props.option.label}</strong>
          {props.option.hint ? <small>{props.option.hint}</small> : undefined}
        </span>
      )}
    </>
  );
}

function SignIn(props: { step: WizardStep }) {
  const deviceCode = createMemo(() => props.step.deviceCode);
  const copyLabel = () =>
    t(deviceCode() ? "modelSetup.wizard.copyCode" : "modelSetup.wizard.copyLink");
  const copyValue = createMemo(() => deviceCode()?.code ?? props.step.externalUrl);
  return (
    <div class="wizard-step__sign-in">
      <p class="muted">{deviceCode()?.message ?? t("modelSetup.wizard.browserInstructions")}</p>
      <Show when={deviceCode()}>
        {(code) => <code class="wizard-step__sign-in-code">{code().code}</code>}
      </Show>
      <div class="wizard-step__actions">
        {props.step.externalUrl ? (
          <a
            class="btn primary wizard-step__external-link"
            data-link-reader-external
            href={props.step.externalUrl}
            target="_blank"
            rel="noreferrer"
          >
            {t("modelSetup.wizard.openSignIn")}
          </a>
        ) : undefined}
        <Show when={copyValue()} keyed>
          {(value) => (
            <button
              type="button"
              class="btn"
              onClick={(event) => void handleCopyButton(event, value, copyLabel())}
            >
              <span data-copy-label>{copyLabel()}</span>
            </button>
          )}
        </Show>
      </div>
      <div class="muted" role="status" aria-live="polite">
        {t("modelSetup.wizard.waiting")}
      </div>
      {deviceCode()?.expiresInMinutes ? (
        <div class="muted">
          {t("modelSetup.wizard.expires", { count: String(deviceCode()?.expiresInMinutes) })}
        </div>
      ) : undefined}
      {deviceCode() ? <p class="muted">{t("modelSetup.wizard.deviceCodeWarning")}</p> : undefined}
    </div>
  );
}

function SingleChoice(props: WizardStepControlsProps) {
  const options = createMemo(() => props.step.options ?? []);
  return (
    <>
      {props.presentation !== "channels" && options().length <= 2 ? (
        <div
          class="wizard-step__actions"
          role="group"
          aria-label={stepLabel(props.step)}
          aria-describedby={props.validationErrorId}
        >
          <For each={options()} keyed={false}>
            {(option, index) => (
              <button
                type="button"
                class={index === 0 ? "btn primary" : "btn"}
                disabled={props.busy}
                onClick={() => props.onAnswer(option().value)}
              >
                <OptionBody option={option()} />
              </button>
            )}
          </For>
        </div>
      ) : (
        <SingleChoicePicker {...props} />
      )}
    </>
  );
}

function SingleChoicePicker(props: WizardStepControlsProps) {
  const options = createMemo(() => props.step.options ?? []);
  const selectedIndex = createMemo(() =>
    options().findIndex((option) => Object.is(option.value, props.value)),
  );
  const channels = () =>
    props.presentation === "channels" &&
    props.channelSelect &&
    options().every((option) => typeof option.value === "string");
  const params = createMemo<PickerParams<PickerOption>>(() => ({
    label: stepLabel(props.step),
    value:
      selectedIndex() < 0
        ? null
        : channels()
          ? String(options()[selectedIndex()]?.value)
          : String(selectedIndex()),
    options: options().map((option, index) => ({
      value: channels() ? String(option.value) : String(index),
      label: option.label,
      description: option.hint,
    })),
    disabled: props.busy,
    invalid: Boolean(props.validationErrorId),
    describedBy: props.validationErrorId,
    onChange: (value) => props.onAnswer(channels() ? value : options()[Number(value)]?.value),
    ...(channels()
      ? {
          renderLeading: (option: PickerOption) =>
            renderChannelIcon(option.value, option.label, "picker"),
        }
      : {}),
  }));
  return (
    <openclaw-select-picker
      class={["settings-select picker-select", { "channel-picker": channels() }]}
      style={{ width: "100%", "min-width": "min(138px,100%)" }}
      prop:params={params()}
    />
  );
}

type AnswerButtonProps = WizardStepControlsProps & {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  omitLeadingAction?: boolean;
};

function AnswerControl(props: AnswerButtonProps) {
  const buttonLabel = () => props.answerLabel ?? props.label;
  const channelBusy = () => props.presentation === "channels" && props.busy;
  return (
    <button
      type={props.onClick || channelBusy() ? "button" : "submit"}
      class="btn primary"
      disabled={channelBusy() || (props.disabled ?? props.busy)}
      aria-busy={channelBusy() ? "true" : undefined}
      aria-label={channelBusy() ? t("modelSetup.wizard.continue") : undefined}
      onClick={() => props.onClick?.()}
    >
      {channelBusy() ? (
        <>
          <span class="btn__label">{t("modelSetup.wizard.continue")}</span>
          <span class="btn__spinner" aria-hidden="true" />
          <span class="sr-only" role="status" aria-live="polite">
            {props.busyLabel ?? buttonLabel()}
          </span>
        </>
      ) : (
        buttonLabel()
      )}
    </button>
  );
}

function AnswerButton(props: AnswerButtonProps) {
  return (
    <>
      {props.presentation === "channels" ? (
        <div class="channels-wizard__footer">
          <AnswerControl {...props} />
        </div>
      ) : props.leadingAction && !props.omitLeadingAction ? (
        <div class="wizard-step__actions wizard-step__actions--split">
          {props.leadingAction}
          <AnswerControl {...props} />
        </div>
      ) : (
        <AnswerControl {...props} />
      )}
    </>
  );
}

function Option(props: WizardStepControlsProps & { option: WizardStepOption }) {
  const selected = createMemo(() => (Array.isArray(props.value) ? props.value : []));
  const checked = createMemo(() =>
    selected().some((value) => Object.is(value, props.option.value)),
  );
  return (
    <>
      {props.presentation === "channels" ? (
        <button
          type="button"
          class="channels-wizard__option"
          aria-pressed={checked() ? "true" : "false"}
          disabled={props.busy}
          aria-invalid={props.validationErrorId ? "true" : undefined}
          aria-describedby={props.validationErrorId}
          onClick={() => props.onValueChange(props.option.value)}
        >
          <OptionBody
            option={props.option}
            presentation={props.presentation}
            selected={checked()}
          />
        </button>
      ) : (
        <label class="wizard-step__option">
          <input
            type="checkbox"
            prop:checked={checked()}
            disabled={props.busy}
            aria-invalid={props.validationErrorId ? "true" : undefined}
            aria-describedby={props.validationErrorId}
            onChange={(event) =>
              props.onValueChange(
                event.currentTarget.checked
                  ? [...selected(), props.option.value]
                  : selected().filter((value) => !Object.is(value, props.option.value)),
              )
            }
          />
          <OptionBody option={props.option} />
        </label>
      )}
    </>
  );
}

function ExternalStepInfo(props: { step: WizardStep }) {
  return (
    <>
      {props.step.externalUrl || props.step.deviceCode ? <SignIn step={props.step} /> : undefined}
    </>
  );
}

function ContinueStep(props: WizardStepControlsProps) {
  return (
    <>
      <Message {...props} />
      <ExternalStepInfo step={props.step} />
      <AnswerButton
        {...props}
        label={t("modelSetup.wizard.continue")}
        onClick={() => props.onAnswer(undefined)}
      />
    </>
  );
}

function ProgressStep(props: WizardStepControlsProps) {
  return (
    <>
      {props.step.externalUrl || props.step.deviceCode ? undefined : (
        <div class="wizard-step__progress" role="status" aria-live="polite">
          <span class="wizard-step__spinner" aria-hidden="true" />
          <Message {...props} />
        </div>
      )}
      <ExternalStepInfo step={props.step} />
      {props.leadingAction ? (
        <div class="wizard-step__actions wizard-step__actions--split">{props.leadingAction}</div>
      ) : undefined}
    </>
  );
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function maskedValue(value: string): string {
  return "*".repeat(Array.from(graphemeSegmenter.segment(value)).length);
}

function syncMask(input: HTMLInputElement): void {
  const mask = input
    .closest("[data-sensitive-input]")
    ?.querySelector<HTMLElement>("[data-sensitive-mask-text]");
  if (mask) {
    mask.textContent = maskedValue(input.value);
    mask.style.transform = `translateX(${-input.scrollLeft}px)`;
  }
}

function SensitiveInput(props: WizardStepControlsProps) {
  const value = createMemo(() => (typeof props.value === "string" ? props.value : ""));
  const visibilityLabel = () =>
    t(props.sensitiveRevealed ? "configForm.hideValue" : "configForm.revealValue");
  const handleMaskSync = (event: Event) => syncMask(event.currentTarget as HTMLInputElement);
  return (
    <span
      class="oc-sensitive-input"
      data-sensitive-input
      data-sensitive-mask-ready="true"
      data-revealed={String(props.sensitiveRevealed === true)}
    >
      <span
        class="oc-sensitive-mask"
        aria-hidden="true"
        data-sensitive-mask
        hidden={props.sensitiveRevealed}
      >
        <span
          data-sensitive-mask-text
          prop:textContent={props.sensitiveRevealed ? "" : maskedValue(value())}
        />
      </span>
      <input
        id={props.inputId}
        class="input"
        name="wizard-text"
        type={props.sensitiveRevealed ? "text" : "password"}
        autocomplete="off"
        spellcheck="false"
        placeholder={props.step.placeholder ?? ""}
        prop:value={value()}
        disabled={props.busy}
        aria-invalid={props.validationErrorId ? "true" : undefined}
        aria-describedby={props.validationErrorId}
        aria-label={props.step.message ? undefined : stepLabel(props.step)}
        data-sensitive-value
        onInput={(event) => {
          syncMask(event.currentTarget);
          props.onValueChange(event.currentTarget.value);
        }}
        onChange={handleMaskSync}
        onFocus={handleMaskSync}
        onScroll={handleMaskSync}
      />
      <openclaw-tooltip prop:content={visibilityLabel()}>
        <button
          type="button"
          class="oc-sensitive-toggle"
          aria-label={visibilityLabel()}
          aria-controls={props.inputId}
          aria-pressed={String(props.sensitiveRevealed === true)}
          data-sensitive-icon={props.sensitiveRevealed ? "eye-off" : "eye"}
          disabled={props.busy}
          onClick={() => props.onToggleSensitiveVisibility?.()}
        >
          <Icon name={props.sensitiveRevealed ? "eyeOff" : "eye"} />
        </button>
      </openclaw-tooltip>
    </span>
  );
}

function TextStepForm(props: WizardStepControlsProps) {
  const value = createMemo(() => (typeof props.value === "string" ? props.value : ""));
  return (
    <form
      class="wizard-step__form"
      onSubmit={(event) => {
        event.preventDefault();
        const formInput = event.currentTarget.elements.namedItem(
          "wizard-text",
        ) as HTMLInputElement | null;
        props.onAnswer(props.presentation === "channels" ? (formInput?.value ?? "") : value());
      }}
    >
      {props.step.message ? (
        <div class={stepClass(props, "message")}>
          <label for={props.inputId}>{formatUiExternalText(props.step.message)}</label>
        </div>
      ) : undefined}
      {props.externalAuthInput ? undefined : <ExternalStepInfo step={props.step} />}
      {props.step.sensitive && props.onToggleSensitiveVisibility ? (
        <SensitiveInput {...props} />
      ) : (
        <input
          id={props.inputId}
          class="input"
          name="wizard-text"
          type={props.step.sensitive ? "password" : "text"}
          autocomplete={props.step.sensitive ? "off" : "on"}
          placeholder={props.step.placeholder ?? ""}
          prop:value={value()}
          disabled={props.busy}
          aria-invalid={props.validationErrorId ? "true" : undefined}
          aria-describedby={props.validationErrorId}
          aria-label={props.step.message ? undefined : stepLabel(props.step)}
          onInput={(event) =>
            props.presentation !== "channels" && props.onValueChange(event.currentTarget.value)
          }
        />
      )}
      <AnswerButton
        {...props}
        omitLeadingAction={props.externalAuthInput}
        label={t("modelSetup.wizard.submit")}
      />
    </form>
  );
}

function TextStep(props: WizardStepControlsProps) {
  return (
    <>
      {props.externalAuthInput ? (
        <>
          <ExternalStepInfo step={props.step} />
          <details class="wizard-step__manual-entry">
            <summary class="muted">{t("modelSetup.wizard.manualEntry")}</summary>
            <TextStepForm {...props} />
          </details>
          <div class="wizard-step__actions wizard-step__actions--split">{props.leadingAction}</div>
        </>
      ) : (
        <TextStepForm {...props} />
      )}
    </>
  );
}

function OptionsStep(props: WizardStepControlsProps) {
  const options = createMemo(() => props.step.options ?? []);
  const selected = createMemo(() => (Array.isArray(props.value) ? props.value : []));
  return (
    <>
      {props.step.type !== "multiselect" ? (
        <>
          <Message {...props} />
          <SingleChoice {...props} />
          {props.presentation !== "channels" ? (
            props.leadingAction
          ) : props.busy ? (
            <AnswerButton {...props} label={t("modelSetup.wizard.continue")} disabled />
          ) : undefined}
        </>
      ) : (
        <>
          <Message {...props} />
          <div
            class={stepClass(props, "options")}
            role="group"
            aria-label={stepLabel(props.step)}
            aria-describedby={props.validationErrorId}
          >
            <For each={options()} keyed={false}>
              {(option) => <Option {...props} option={option()} />}
            </For>
          </div>
          <AnswerButton
            {...props}
            label={t("modelSetup.wizard.continue")}
            onClick={() =>
              props.onAnswer(props.presentation === "channels" ? [...selected()] : selected())
            }
          />
        </>
      )}
    </>
  );
}

function ConfirmStep(props: WizardStepControlsProps) {
  const actionClass = () =>
    stepClass(props, props.presentation === "channels" ? "footer" : "actions");
  return (
    <>
      <Message {...props} />
      <div
        class={
          props.presentation !== "channels" && props.leadingAction
            ? `${actionClass()} wizard-step__actions--split`
            : actionClass()
        }
      >
        {props.presentation === "channels" ? undefined : props.leadingAction}
        {props.presentation === "channels" && props.busy ? (
          renderWizardBusyButton(props.busyLabel ?? t("common.loading"))
        ) : (
          <For each={[false, true]}>
            {(answer) => (
              <button
                type="button"
                class={answer ? "btn primary" : "btn"}
                disabled={props.busy}
                onClick={() => props.onAnswer(answer)}
              >
                {answer ? (props.confirmAffirmativeLabel ?? t("common.yes")) : t("common.no")}
              </button>
            )}
          </For>
        )}
      </div>
    </>
  );
}

export function WizardStepControls(props: WizardStepControlsProps): JSX.Element {
  return (
    <Switch>
      <Match when={props.step.type === "text"}>
        <TextStep {...props} />
      </Match>
      <Match when={props.step.type === "select" || props.step.type === "multiselect"}>
        <OptionsStep {...props} />
      </Match>
      <Match when={props.step.type === "confirm"}>
        <ConfirmStep {...props} />
      </Match>
      <Match when={props.step.type === "progress"}>
        {props.step.executor === "gateway" ? (
          <ProgressStep {...props} />
        ) : (
          <ContinueStep {...props} />
        )}
      </Match>
      <Match when={props.step.type === "note"}>
        {props.busy && (props.step.externalUrl || props.step.deviceCode) ? (
          <ProgressStep {...props} />
        ) : (
          <ContinueStep {...props} />
        )}
      </Match>
      <Match when={props.step.type === "action"}>
        <ContinueStep {...props} />
      </Match>
    </Switch>
  );
}

export function renderWizardStepControls(props: WizardStepControlsProps): JSX.Element {
  return <WizardStepControls {...props} />;
}
