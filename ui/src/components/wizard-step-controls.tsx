import { Dynamic, type JSX } from "@solidjs/web";
import { createMemo, For, Match, Show, Switch } from "solid-js";
import type { WizardStep } from "../api/types.ts";
import { registerModelSetupEnglish } from "../i18n/locales/en-model-setup.ts";
import { formatUiExternalText } from "../lib/format-error.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { liveValue } from "../lib/reactive/live-value.ts";
import { handleCopyButton } from "./copy-button-state.ts";
import { Picker, type PickerParams } from "./select-picker.ts";
import { SensitiveInput } from "./sensitive-input.tsx";
import { ChannelPicker, type ChannelPickerOption } from "./solid/channel-picker.tsx";
import { ModelSetupSignIn } from "./wizard-sign-in.tsx";
import "../styles/wizard-step-controls.css";

registerEnglishCatalog(registerModelSetupEnglish);

type WizardStepOption = NonNullable<WizardStep["options"]>[number];
type WizardStepControlsProps = {
  step: WizardStep;
  value: unknown;
  busy: boolean;
  inputId: string;
  validationErrorId?: string;
  onValueChange: (value: unknown) => void;
  onAnswer: (value: unknown) => void;
  onAutofocusRef?: (element: HTMLElement) => void;
  confirmAffirmativeLabel?: string;
  leadingAction?: JSX.Element;
  externalAuthInput?: boolean;
  /** Model-setup sign-in identity: Gateway brand id (icon) and display name. */
  brandId?: string;
  providerLabel?: string;
  signInIcon?: JSX.Element;
  presentation?: "channels" | "model-setup";
  channelSelect?: boolean;
  answerLabel?: string;
  busyLabel?: string;
  sensitiveRevealed?: boolean;
  onToggleSensitiveVisibility?: () => void;
};

function stepClass(props: WizardStepControlsProps, name: string) {
  return `${props.presentation === "channels" ? "channels-wizard" : "wizard-step"}__${name}`;
}

export function WizardBusyButton(props: { statusLabel: string }) {
  const label = () => t("modelSetup.wizard.continue");
  return (
    <button type="button" class="btn primary" disabled aria-busy="true" aria-label={label()}>
      <span class="btn__label">{label()}</span>
      <span class="btn__spinner" aria-hidden="true" />
      <span class="sr-only" role="status" aria-live="polite">
        {props.statusLabel}
      </span>
    </button>
  );
}

function Message(props: WizardStepControlsProps) {
  return (
    <Show when={props.step.message}>
      <div class={stepClass(props, "message")}>
        <Show
          when={props.presentation === "model-setup"}
          fallback={
            <>
              {"\n        "}
              {formatUiExternalText(props.step.message!)}
              {"\n      "}
            </>
          }
        >
          <For each={formatUiExternalText(props.step.message!).split("\n\n")} keyed={false}>
            {(paragraph, index) => <p class={index === 0 ? undefined : "muted"}>{paragraph()}</p>}
          </For>
        </Show>
      </div>
    </Show>
  );
}

function OptionBody(props: { option: WizardStepOption; channels?: boolean; selected?: boolean }) {
  return (
    <Show
      when={props.channels}
      fallback={
        <span>
          <strong>{props.option.label}</strong>
          <Show when={props.option.hint}>
            <small>{props.option.hint}</small>
          </Show>
        </span>
      }
    >
      <span class="channels-wizard__option-label">
        {props.selected === undefined ? "" : props.selected ? "☑ " : "☐ "}
        {props.option.label}
      </span>
      <Show when={props.option.hint}>
        <span class="channels-wizard__option-hint">{props.option.hint}</span>
      </Show>
    </Show>
  );
}

type SignInProps = Pick<
  WizardStepControlsProps,
  "step" | "presentation" | "onAutofocusRef" | "brandId" | "providerLabel" | "signInIcon"
> & { waiting: boolean };

function SignIn(props: SignInProps) {
  return (
    <Show when={props.step.externalUrl || props.step.deviceCode}>
      <Show when={props.presentation === "model-setup"} fallback={<EmbeddedSignIn {...props} />}>
        <ModelSetupSignIn
          step={props.step}
          waiting={props.waiting}
          icon={props.signInIcon}
          brandId={props.brandId}
          providerLabel={props.providerLabel}
          onAutofocusRef={props.onAutofocusRef}
        />
      </Show>
    </Show>
  );
}

function EmbeddedSignIn(props: SignInProps) {
  const code = createMemo(() => props.step.deviceCode);
  const copyLabel = () => t(code() ? "modelSetup.wizard.copyCode" : "modelSetup.wizard.copyLink");
  const copyValue = createMemo(() => code()?.code ?? props.step.externalUrl);
  return (
    <div class="wizard-step__sign-in">
      <p class="muted">{code()?.message ?? t("modelSetup.wizard.browserInstructions")}</p>
      <Show when={code()}>
        {(value) => <code class="wizard-step__sign-in-code">{value().code}</code>}
      </Show>
      <div class="wizard-step__actions">
        <Show when={props.step.externalUrl}>
          <a
            ref={(element) => props.onAutofocusRef?.(element)}
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
          {(value) => {
            let label!: HTMLSpanElement;
            return (
              <button
                type="button"
                class="btn"
                onClick={(event) => void handleCopyButton(event, value, copyLabel(), { label })}
              >
                <span ref={(element) => (label = element)} data-copy-label>
                  {copyLabel()}
                </span>
              </button>
            );
          }}
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
  );
}

function ActionRow(props: {
  modal: boolean;
  class: JSX.HTMLAttributes<HTMLDivElement>["class"];
  children: JSX.Element;
}) {
  return (
    <Dynamic component={props.modal ? "openclaw-modal-actions" : "div"} class={props.class}>
      {props.children}
    </Dynamic>
  );
}

function Answer(props: WizardStepControlsProps & { label: string; onClick?: () => void }) {
  const label = () => props.answerLabel ?? props.label;
  const button = (
    <button
      ref={(element) => props.onAutofocusRef?.(element)}
      type={props.onClick ? "button" : "submit"}
      class="btn primary"
      autofocus={props.presentation === "model-setup"}
      disabled={props.busy}
      onClick={() => props.onClick?.()}
    >
      {label()}
    </button>
  );
  return (
    <Show
      when={props.presentation === "channels"}
      fallback={
        <Show
          when={
            (props.presentation === "model-setup" && !props.externalAuthInput) ||
            props.leadingAction
          }
          fallback={button}
        >
          <ActionRow
            modal={props.presentation === "model-setup" && !props.externalAuthInput}
            class="wizard-step__actions wizard-step__actions--split"
          >
            {props.leadingAction}
            {button}
          </ActionRow>
        </Show>
      }
    >
      <openclaw-modal-actions class="channels-wizard__footer">
        <Show when={props.busy} fallback={button}>
          <WizardBusyButton statusLabel={props.busyLabel ?? label()} />
        </Show>
      </openclaw-modal-actions>
    </Show>
  );
}

function TextForm(props: WizardStepControlsProps) {
  // Channel drafts stay in the input until submit; unrelated refreshes must not overwrite them.
  const value = createMemo(() => (typeof props.value === "string" ? props.value : ""));
  return (
    <form
      class="wizard-step__form"
      onSubmit={(event) => {
        event.preventDefault();
        const input = event.currentTarget.elements.namedItem("wizard-text");
        props.onAnswer(
          props.presentation === "channels" && input instanceof HTMLInputElement
            ? input.value
            : value(),
        );
      }}
    >
      <Show when={props.step.message}>
        <div class={stepClass(props, "message")}>
          {/* This pre-wrap message retains the original Lit label spacing. */}
          {"\n              "}
          <label for={props.inputId}>{formatUiExternalText(props.step.message!)}</label>
          {"\n            "}
        </div>
      </Show>
      <Show when={!props.externalAuthInput}>
        <SignIn {...props} waiting={false} />
      </Show>
      <Show
        when={props.step.sensitive && props.onToggleSensitiveVisibility}
        fallback={
          <input
            id={props.inputId}
            class="input"
            name="wizard-text"
            type={props.step.sensitive ? "password" : "text"}
            autocomplete={props.step.sensitive ? "off" : "on"}
            placeholder={props.step.placeholder ?? ""}
            ref={liveValue(value)}
            disabled={props.busy}
            aria-invalid={props.validationErrorId ? "true" : undefined}
            aria-describedby={props.validationErrorId}
            aria-label={
              props.step.message ? undefined : props.step.title || t("chat.questions.answer")
            }
            onInput={(event) =>
              props.presentation !== "channels" && props.onValueChange(event.currentTarget.value)
            }
          />
        }
      >
        <SensitiveInput
          id={props.inputId}
          value={value()}
          revealed={props.sensitiveRevealed === true}
          placeholder={props.step.placeholder}
          disabled={props.busy}
          invalid={Boolean(props.validationErrorId)}
          describedBy={props.validationErrorId}
          label={props.step.message ? undefined : props.step.title || t("chat.questions.answer")}
          onInput={props.onValueChange}
          onToggle={() => props.onToggleSensitiveVisibility?.()}
        />
      </Show>
      <Answer
        {...props}
        leadingAction={props.externalAuthInput ? undefined : props.leadingAction}
        label={t("modelSetup.wizard.submit")}
      />
    </form>
  );
}

function TextStep(props: WizardStepControlsProps) {
  return (
    <Show when={props.externalAuthInput} fallback={<TextForm {...props} />}>
      <SignIn {...props} waiting />
      <details class="wizard-step__manual-entry">
        <summary class="muted">{t("modelSetup.wizard.manualEntry")}</summary>
        <TextForm {...props} />
      </details>
      <ActionRow
        modal={props.presentation === "model-setup"}
        class="wizard-step__actions wizard-step__actions--split"
      >
        {props.leadingAction}
      </ActionRow>
    </Show>
  );
}

function SingleChoice(props: WizardStepControlsProps & { options: WizardStepOption[] }) {
  const label = () => props.step.message || props.step.title || t("chat.questions.answer");
  const channels = createMemo(
    () =>
      props.presentation === "channels" &&
      props.channelSelect &&
      props.options.every((option) => typeof option.value === "string"),
  );
  const params = createMemo<PickerParams<ChannelPickerOption>>(() => {
    const selected = props.options.findIndex((option) => Object.is(option.value, props.value));
    return {
      label: label(),
      value:
        selected < 0
          ? null
          : channels()
            ? String(props.options[selected]?.value)
            : String(selected),
      options: props.options.map<ChannelPickerOption>((option, index) => ({
        value: channels() ? String(option.value) : String(index),
        label: option.label,
        description: option.hint,
        kind: channels() ? "channel" : "neutral",
      })),
      disabled: props.busy,
      invalid: Boolean(props.validationErrorId),
      describedBy: props.validationErrorId,
      onChange: (value) => props.onAnswer(channels() ? value : props.options[Number(value)]?.value),
    };
  });
  return (
    <Show
      when={props.presentation !== "channels" && props.options.length <= 2}
      fallback={
        <Show when={channels()} fallback={<Picker params={params()} />}>
          <ChannelPicker {...params()} />
        </Show>
      }
    >
      <div
        class={[
          "wizard-step__actions",
          {
            "wizard-step__actions--split":
              props.presentation === "model-setup" && Boolean(props.leadingAction),
          },
        ]}
        role="group"
        aria-label={label()}
        aria-describedby={props.validationErrorId}
      >
        <Show when={props.presentation === "model-setup"}>{props.leadingAction}</Show>
        <For each={props.options} keyed={false}>
          {(option, index) => (
            <button
              ref={(element) => props.onAutofocusRef?.(element)}
              type="button"
              class={index === 0 ? "btn primary" : "btn"}
              autofocus={props.presentation === "model-setup" && index === 0}
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

function MultipleChoice(props: WizardStepControlsProps & { options: WizardStepOption[] }) {
  const selected = (): readonly unknown[] => (Array.isArray(props.value) ? props.value : []);
  return (
    <>
      <div
        class={stepClass(props, "options")}
        role="group"
        aria-label={props.step.message || props.step.title || t("chat.questions.answer")}
        aria-describedby={props.validationErrorId}
      >
        <For each={props.options} keyed={false}>
          {(option) => (
            <Show
              when={props.presentation === "channels"}
              fallback={
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
              }
            >
              <button
                type="button"
                class="channels-wizard__option"
                disabled={props.busy}
                aria-pressed={
                  selected().some((value) => Object.is(value, option().value)) ? "true" : "false"
                }
                aria-invalid={props.validationErrorId ? "true" : undefined}
                aria-describedby={props.validationErrorId}
                onClick={() => props.onValueChange(option().value)}
              >
                <OptionBody
                  option={option()}
                  channels
                  selected={selected().some((value) => Object.is(value, option().value))}
                />
              </button>
            </Show>
          )}
        </For>
      </div>
      <Answer
        {...props}
        label={t("modelSetup.wizard.continue")}
        onClick={() =>
          props.onAnswer(props.presentation === "channels" ? [...selected()] : selected())
        }
      />
    </>
  );
}

function OptionsStep(props: WizardStepControlsProps) {
  const options = createMemo(() => props.step.options ?? []);
  return (
    <>
      <Message {...props} />
      <Show
        when={props.step.type === "multiselect"}
        fallback={
          <>
            <SingleChoice {...props} options={options()} />
            {props.presentation === "channels"
              ? props.busy && <Answer {...props} label={t("modelSetup.wizard.continue")} />
              : props.presentation === "model-setup"
                ? options().length > 2 &&
                  props.leadingAction && (
                    <openclaw-modal-actions class="wizard-step__actions wizard-step__actions--split">
                      {props.leadingAction}
                    </openclaw-modal-actions>
                  )
                : props.leadingAction}
          </>
        }
      >
        <MultipleChoice {...props} options={options()} />
      </Show>
    </>
  );
}

function ConfirmStep(props: WizardStepControlsProps) {
  return (
    <>
      <Message {...props} />
      <ActionRow
        modal={props.presentation === "channels" || props.presentation === "model-setup"}
        class={[
          stepClass(props, props.presentation === "channels" ? "footer" : "actions"),
          {
            "wizard-step__actions--split":
              props.presentation !== "channels" && Boolean(props.leadingAction),
          },
        ]}
      >
        <Show when={props.presentation !== "channels"}>{props.leadingAction}</Show>
        <Show
          when={props.presentation === "channels" && props.busy}
          fallback={
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
          }
        >
          <WizardBusyButton statusLabel={props.busyLabel ?? t("common.loading")} />
        </Show>
      </ActionRow>
    </>
  );
}

function ContinueStep(props: WizardStepControlsProps) {
  return (
    <>
      {/* Model-setup sign-in folds the step message into its own heading block. */}
      <Show
        when={
          props.presentation !== "model-setup" || !(props.step.externalUrl || props.step.deviceCode)
        }
      >
        <Message {...props} />
      </Show>
      <SignIn {...props} waiting={false} />
      <Answer
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
      <Show when={!props.step.externalUrl && !props.step.deviceCode}>
        <div class="wizard-step__progress" role="status" aria-live="polite">
          <span class="wizard-step__spinner" aria-hidden="true" />
          <Message {...props} />
        </div>
      </Show>
      <SignIn {...props} waiting />
      <Show when={props.leadingAction}>
        <ActionRow
          modal={props.presentation === "model-setup"}
          class="wizard-step__actions wizard-step__actions--split"
        >
          {props.leadingAction}
        </ActionRow>
      </Show>
    </>
  );
}

export function WizardStepControls(props: WizardStepControlsProps): JSX.Element {
  return (
    <Switch>
      <Match when={props.step.type === "text"}>
        <Show when={props.step.id} keyed>
          {(_stepId) => <TextStep {...props} />}
        </Show>
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
