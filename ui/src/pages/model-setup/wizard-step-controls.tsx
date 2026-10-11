import type { JSX } from "@solidjs/web";
import { createMemo, For, Match, Show, Switch } from "solid-js";
import type { WizardStep } from "../../api/types.ts";
import { handleCopyButton } from "../../components/copy-button-state.ts";
import type { PickerOption, PickerParams } from "../../components/select-picker.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import "../../components/select-picker.ts";
import "../../styles/wizard-step-controls.css";

type WizardStepOption = NonNullable<WizardStep["options"]>[number];
type StepProps = {
  step: WizardStep;
  value: unknown;
  busy: boolean;
  inputId: string;
  validationErrorId?: string;
  onValueChange: (value: unknown) => void;
  onAnswer: (value: unknown) => void;
  confirmAffirmativeLabel?: string;
  leadingAction?: JSX.Element;
  externalAuthInput?: boolean;
};

function Message(props: StepProps) {
  return (
    <Show when={props.step.message}>
      <div class="wizard-step__message">{formatUiExternalText(props.step.message!)}</div>
    </Show>
  );
}

function OptionBody(props: { option: WizardStepOption }) {
  return (
    <span>
      <strong>{props.option.label}</strong>
      <Show when={props.option.hint}>
        <small>{props.option.hint}</small>
      </Show>
    </span>
  );
}

function SignIn(props: { step: WizardStep }) {
  const code = createMemo(() => props.step.deviceCode);
  const copyLabel = () => t(code() ? "modelSetup.wizard.copyCode" : "modelSetup.wizard.copyLink");
  const copyValue = createMemo(() => code()?.code ?? props.step.externalUrl);
  return (
    <Show when={props.step.externalUrl || code()}>
      <div class="wizard-step__sign-in">
        <p class="muted">{code()?.message ?? t("modelSetup.wizard.browserInstructions")}</p>
        <Show when={code()}>
          {(value) => <code class="wizard-step__sign-in-code">{value().code}</code>}
        </Show>
        <div class="wizard-step__actions">
          <Show when={props.step.externalUrl}>
            <a
              class="btn primary wizard-step__external-link"
              data-link-reader-external
              href={props.step.externalUrl}
              target="_blank"
              rel="noreferrer"
            >
              {t("modelSetup.wizard.openSignIn")}
            </a>
          </Show>
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
        <Show when={code()?.expiresInMinutes}>
          <div class="muted">
            {t("modelSetup.wizard.expires", { count: String(code()?.expiresInMinutes) })}
          </div>
        </Show>
        <Show when={code()}>
          <p class="muted">{t("modelSetup.wizard.deviceCodeWarning")}</p>
        </Show>
      </div>
    </Show>
  );
}

function Answer(props: StepProps & { label: string; onClick?: () => void }) {
  const button = (
    <button
      type={props.onClick ? "button" : "submit"}
      class="btn primary"
      disabled={props.busy}
      onClick={() => props.onClick?.()}
    >
      {props.label}
    </button>
  );
  return (
    <Show when={props.leadingAction} fallback={button}>
      <div class="wizard-step__actions wizard-step__actions--split">
        {props.leadingAction}
        {button}
      </div>
    </Show>
  );
}

function TextForm(props: StepProps) {
  const value = () => (typeof props.value === "string" ? props.value : "");
  return (
    <form
      class="wizard-step__form"
      onSubmit={(event) => {
        event.preventDefault();
        props.onAnswer(value());
      }}
    >
      <Show when={props.step.message}>
        <div class="wizard-step__message">
          {/* This pre-wrap message retains the original Lit label spacing. */}
          {"\n              "}
          <label for={props.inputId}>{formatUiExternalText(props.step.message!)}</label>
          {"\n            "}
        </div>
      </Show>
      <Show when={!props.externalAuthInput}>
        <SignIn step={props.step} />
      </Show>
      <input
        id={props.inputId}
        class="input"
        name="wizard-text"
        type={props.step.sensitive ? "password" : "text"}
        autocomplete={props.step.sensitive ? "off" : "on"}
        placeholder={props.step.placeholder ?? ""}
        value={value()}
        disabled={props.busy}
        aria-invalid={props.validationErrorId ? "true" : undefined}
        aria-describedby={props.validationErrorId}
        aria-label={props.step.message ? undefined : props.step.title || t("chat.questions.answer")}
        onInput={(event) => props.onValueChange(event.currentTarget.value)}
      />
      <Answer
        {...props}
        leadingAction={props.externalAuthInput ? undefined : props.leadingAction}
        label={t("modelSetup.wizard.submit")}
      />
    </form>
  );
}

function TextStep(props: StepProps) {
  return (
    <Show when={props.externalAuthInput} fallback={<TextForm {...props} />}>
      <SignIn step={props.step} />
      <details class="wizard-step__manual-entry">
        <summary class="muted">{t("modelSetup.wizard.manualEntry")}</summary>
        <TextForm {...props} />
      </details>
      <div class="wizard-step__actions wizard-step__actions--split">{props.leadingAction}</div>
    </Show>
  );
}

function SingleChoice(props: StepProps & { options: WizardStepOption[] }) {
  const label = () => props.step.message || props.step.title || t("chat.questions.answer");
  const params = createMemo<PickerParams<PickerOption>>(() => {
    const selected = props.options.findIndex((option) => Object.is(option.value, props.value));
    return {
      label: label(),
      value: selected < 0 ? null : String(selected),
      options: props.options.map((option, index) => ({
        value: String(index),
        label: option.label,
        description: option.hint,
      })),
      disabled: props.busy,
      invalid: Boolean(props.validationErrorId),
      describedBy: props.validationErrorId,
      onChange: (value) => props.onAnswer(props.options[Number(value)]?.value),
    };
  });
  return (
    <Show
      when={props.options.length <= 2}
      fallback={
        <openclaw-select-picker
          class="settings-select picker-select"
          style={{ width: "100%", "min-width": "min(138px,100%)" }}
          prop:params={params()}
        />
      }
    >
      <div
        class="wizard-step__actions"
        role="group"
        aria-label={label()}
        aria-describedby={props.validationErrorId}
      >
        <For each={props.options} keyed={false}>
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
    </Show>
  );
}

function MultipleChoice(props: StepProps & { options: WizardStepOption[] }) {
  const selected = () => (Array.isArray(props.value) ? props.value : []);
  return (
    <>
      <div
        class="wizard-step__options"
        role="group"
        aria-label={props.step.message || props.step.title || t("chat.questions.answer")}
        aria-describedby={props.validationErrorId}
      >
        <For each={props.options} keyed={false}>
          {(option) => (
            <label class="wizard-step__option">
              <input
                type="checkbox"
                checked={selected().some((value) => Object.is(value, option().value))}
                disabled={props.busy}
                aria-invalid={props.validationErrorId ? "true" : undefined}
                aria-describedby={props.validationErrorId}
                onChange={(event) =>
                  props.onValueChange(
                    event.currentTarget.checked
                      ? [...selected(), option().value]
                      : selected().filter((value) => !Object.is(value, option().value)),
                  )
                }
              />
              <OptionBody option={option()} />
            </label>
          )}
        </For>
      </div>
      <Answer
        {...props}
        label={t("modelSetup.wizard.continue")}
        onClick={() => props.onAnswer(selected())}
      />
    </>
  );
}

function OptionsStep(props: StepProps) {
  const options = createMemo(() => props.step.options ?? []);
  return (
    <>
      <Message {...props} />
      <Show
        when={props.step.type === "multiselect"}
        fallback={
          <>
            <SingleChoice {...props} options={options()} />
            {props.leadingAction}
          </>
        }
      >
        <MultipleChoice {...props} options={options()} />
      </Show>
    </>
  );
}

function ConfirmStep(props: StepProps) {
  return (
    <>
      <Message {...props} />
      <div
        class={[
          "wizard-step__actions",
          { "wizard-step__actions--split": Boolean(props.leadingAction) },
        ]}
      >
        {props.leadingAction}
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
      </div>
    </>
  );
}

function ContinueStep(props: StepProps) {
  return (
    <>
      <Message {...props} />
      <SignIn step={props.step} />
      <Answer
        {...props}
        label={t("modelSetup.wizard.continue")}
        onClick={() => props.onAnswer(undefined)}
      />
    </>
  );
}

function ProgressStep(props: StepProps) {
  return (
    <>
      <Show when={!props.step.externalUrl && !props.step.deviceCode}>
        <div class="wizard-step__progress" role="status" aria-live="polite">
          <span class="wizard-step__spinner" aria-hidden="true" />
          <Message {...props} />
        </div>
      </Show>
      <SignIn step={props.step} />
      <Show when={props.leadingAction}>
        <div class="wizard-step__actions wizard-step__actions--split">{props.leadingAction}</div>
      </Show>
    </>
  );
}

export function WizardStepControls(props: StepProps): JSX.Element {
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
