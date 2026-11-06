import type { JSX } from "@solidjs/web";
import { createMemo, For, Match, Show, Switch } from "solid-js";
import { CopyButton } from "../../components/solid/copy-button.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { IconButton } from "../../components/solid/icon-button.tsx";
import { WizardStepControls } from "../../components/wizard-step-controls.tsx";
import "../../components/modal-dialog.tsx";
import { registerModelSetupEnglish } from "../../i18n/locales/en-model-setup.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { createPendingFocus } from "../../lib/reactive/pending-focus.ts";
import type { ModelSetupWizardState } from "./state.ts";
import { WIZARD_COPY } from "./wizard-copy.ts";

registerModelSetupEnglish();

export type WizardViewProps = {
  onDialogRef?: (element: import("../../components/modal-dialog.tsx").OpenClawModalDialog) => void;
  mode: "auth" | "prepare" | "activate";
  state: ModelSetupWizardState;
  busy?: boolean;
  admissionPending?: boolean;
  refreshWarning: string | null;
  doneMessage?: string;
  doneDescription?: string;
  doneAction?: { label: string; disabled?: boolean; onClick: () => void };
  cancellationNotice?: string | null;
  cancellationFeedback?: JSX.Element;
  signInIcon?: JSX.Element;
  value: unknown;
  onValueChange: (value: unknown) => void;
  onAnswer: (value: unknown, includeValue?: boolean) => void;
  onCancel: () => void;
  onClose: () => void;
};

export function ModelSetupWizard(props: WizardViewProps): JSX.Element {
  let focusTargets = new Set<HTMLElement>();
  const autofocusRef = (element: HTMLElement) => {
    focusTargets.add(element);
  };
  const initialFocus = () =>
    [...focusTargets]
      .filter((element) => element.isConnected && element.autofocus)
      .toSorted((left, right) =>
        left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
      )[0] ?? null;
  const displayPhase = () =>
    props.admissionPending && props.state.phase === "idle" ? "starting" : props.state.phase;
  // Focus the committed wizard step after its identity or completion actions change.
  createPendingFocus(
    () =>
      props.state.phase === "step"
        ? `${props.state.step.id}:${props.busy || props.state.busy ? "busy" : "ready"}:${props.state.validationError ?? ""}`
        : `${displayPhase()}:${Boolean(props.doneAction)}`,
    {
      requested: () => true,
      focus: () => {
        focusTargets = new Set([...focusTargets].filter((element) => element.isConnected));
        initialFocus()?.focus({ preventScroll: true });
      },
    },
  );
  const copy = () => WIZARD_COPY[props.mode];
  const canCancel = () => displayPhase() === "starting" || displayPhase() === "step";
  const stepState = () => (props.state.phase === "step" ? props.state : undefined);
  // Cancel sits beside a primary action. Alone in a footer it would only repeat the close button.
  const stepHasPrimary = () => {
    const current = stepState();
    if (!current) {
      return false;
    }
    const { type, options } = current.step;
    return (
      type === "confirm" ||
      type === "multiselect" ||
      type === "note" ||
      type === "action" ||
      (type === "text" && !current.externalAuthInput) ||
      (type === "select" && (options?.length ?? 0) <= 2)
    );
  };
  // A retiring step still renders action settlement before its controls dispose.
  const retainedStep = createMemo(
    (previous: ReturnType<typeof stepState>) => stepState() ?? previous,
  );
  // Browser sign-in steps carry their own provider heading and corner cancel control.
  const signInStep = () => {
    const step = stepState()?.step;
    return Boolean(step && (step.externalUrl || step.deviceCode));
  };
  const errorState = () =>
    props.state.phase === "error" || props.state.phase === "cancelled" ? props.state : undefined;
  return (
    <Show when={displayPhase() !== "idle"}>
      <openclaw-modal-dialog
        prop:initialFocus={initialFocus}
        ref={(element) => props.onDialogRef?.(element)}
        label={t(copy().dialog)}
        onModal-cancel={() => (canCancel() ? props.onCancel() : props.onClose())}
      >
        <div
          class={[
            "oc-dialog model-setup-wizard",
            {
              "model-setup-wizard--auth": props.mode === "auth",
              "model-setup-wizard--done": displayPhase() === "done",
              "model-setup-wizard--sign-in": signInStep(),
            },
          ]}
        >
          <Show when={signInStep()}>
            <button
              type="button"
              class="model-setup-wizard__close"
              aria-label={t("modelSetup.wizard.cancelSignIn")}
              title={t("modelSetup.wizard.cancelSignIn")}
              onClick={() => props.onCancel()}
            >
              <Icon name="x" />
            </button>
          </Show>
          <Show when={displayPhase() !== "done" && !signInStep()}>
            <div class="oc-dialog__header">
              <h2 class="oc-dialog__title">
                {props.state.authLabel || stepState()?.step.title || t(copy().titleKey)}
              </h2>
              <IconButton
                size={28}
                class="oc-dialog__close"
                icon="x"
                label={t(canCancel() ? "common.cancel" : "common.close")}
                ref={autofocusRef}
                autofocus={displayPhase() !== "step"}
                onClick={() => (canCancel() ? props.onCancel() : props.onClose())}
              />
            </div>
          </Show>
          <div class="oc-dialog__body model-setup-wizard__body">
            <For
              each={[
                props.refreshWarning,
                props.cancellationNotice,
                props.state.phase === "starting" ? props.state.notice : undefined,
              ]}
              keyed={false}
            >
              {(warning) => (
                <Show when={warning()}>
                  <InlineAlert tone="warning" role="alert">
                    {warning()}
                  </InlineAlert>
                </Show>
              )}
            </For>
            {props.cancellationFeedback}
            <Switch>
              <Match when={displayPhase() === "starting"}>
                <div class="wizard-step__progress" role="status" aria-busy="true">
                  <span class="wizard-step__spinner" aria-hidden="true" />
                  {t(copy().starting)}
                </div>
              </Match>
              <Match when={displayPhase() === "done"}>
                <div class="model-setup-wizard__success" role="status">
                  <span class="model-setup-wizard__success-icon" aria-hidden="true">
                    <Icon name="check" />
                  </span>
                  <h2 class="model-setup-wizard__success-title">
                    {props.doneMessage ??
                      t(
                        props.mode === "auth"
                          ? "modelSetup.wizard.connected"
                          : "modelSetup.wizard.checking",
                      )}
                  </h2>
                  <Show when={props.doneDescription}>
                    <p class="model-setup-wizard__success-description">{props.doneDescription}</p>
                  </Show>
                </div>
              </Match>
              <Match when={errorState()}>
                {(state) => (
                  <Show
                    when={props.mode === "auth" && state().phase === "error"}
                    fallback={
                      <InlineAlert tone="danger" role="alert">
                        {state().message}
                      </InlineAlert>
                    }
                  >
                    <InlineAlert tone="danger" class="model-setup-wizard__error" role="alert">
                      <p class="model-setup-wizard__error-text">{state().message}</p>
                      <div class="model-setup-wizard__error-copy">
                        <CopyButton
                          text={state().message}
                          idleLabel={t("modelSetup.wizard.copy")}
                        />
                      </div>
                    </InlineAlert>
                  </Show>
                )}
              </Match>
              <Match when={displayPhase() === "step"}>
                <Show when={retainedStep()}>
                  {(state) => (
                    <>
                      <Show when={state().validationError}>
                        <InlineAlert
                          tone="danger"
                          id="model-setup-wizard-validation-error"
                          role="alert"
                        >
                          {state().validationError}
                        </InlineAlert>
                      </Show>
                      <WizardStepControls
                        presentation="model-setup"
                        step={state().step}
                        externalAuthInput={state().externalAuthInput}
                        signInIcon={props.signInIcon}
                        brandId={props.state.authBrandId}
                        providerLabel={props.state.authLabel}
                        value={props.value}
                        busy={props.busy || state().busy}
                        inputId="model-setup-wizard-text-input"
                        validationErrorId={
                          state().validationError
                            ? "model-setup-wizard-validation-error"
                            : undefined
                        }
                        confirmAffirmativeLabel={
                          props.mode === "prepare" && state().step.type === "confirm"
                            ? t("modelSetup.wizard.continue")
                            : undefined
                        }
                        leadingAction={
                          signInStep() || !stepHasPrimary() ? undefined : (
                            <button type="button" class="btn" onClick={() => props.onCancel()}>
                              {t("common.cancel")}
                            </button>
                          )
                        }
                        onValueChange={(value) => props.onValueChange(value)}
                        onAnswer={(value) => props.onAnswer(value)}
                        onAutofocusRef={autofocusRef}
                      />
                      <Show
                        when={
                          (props.busy || state().busy) &&
                          state().step.type !== "progress" &&
                          !state().step.externalUrl &&
                          !state().step.deviceCode
                        }
                      >
                        <div class="wizard-step__progress" role="status" aria-busy="true">
                          <span class="wizard-step__spinner" aria-hidden="true" />
                          {t("modelSetup.wizard.working")}
                        </div>
                      </Show>
                    </>
                  )}
                </Show>
              </Match>
            </Switch>
          </div>
          <Show when={displayPhase() === "done"}>
            <openclaw-modal-actions class="oc-dialog__footer model-setup-wizard__footer">
              <button
                ref={autofocusRef}
                type="button"
                class="btn"
                autofocus={!props.doneAction}
                onClick={() => props.onClose()}
              >
                {t("common.close")}
              </button>
              <Show when={displayPhase() === "done" && props.doneAction}>
                {(action) => (
                  <button
                    ref={autofocusRef}
                    type="button"
                    class="btn primary"
                    data-login-start-chat
                    autofocus
                    disabled={action().disabled}
                    aria-busy={action().disabled ? "true" : "false"}
                    onClick={() => action().onClick()}
                  >
                    <Show when={action().disabled}>
                      <span class="btn__spinner" aria-hidden="true" />
                    </Show>
                    {action().label}
                  </button>
                )}
              </Show>
            </openclaw-modal-actions>
          </Show>
        </div>
      </openclaw-modal-dialog>
    </Show>
  );
}
