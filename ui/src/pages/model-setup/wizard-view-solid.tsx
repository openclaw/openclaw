import type { JSX } from "@solidjs/web";
import { createMemo, For, Match, Show, Switch } from "solid-js";
import { CopyButton } from "../../components/solid/copy-button.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import "../../components/modal-dialog.ts";
import { WIZARD_COPY } from "./wizard-copy.ts";
import { WizardStepControls } from "./wizard-step-controls.tsx";
import type { WizardViewProps } from "./wizard-view.ts";
export type { WizardViewProps } from "./wizard-view.ts";

export function ModelSetupWizard(props: WizardViewProps): JSX.Element {
  const copy = createMemo(() => WIZARD_COPY[props.mode]);
  const canCancel = () => props.state.phase === "starting" || props.state.phase === "step";
  const stepState = createMemo(() => (props.state.phase === "step" ? props.state : undefined));
  const errorState = createMemo(() =>
    props.state.phase === "error" || props.state.phase === "cancelled" ? props.state : undefined,
  );
  return (
    <Show when={props.state.phase !== "idle"}>
      <openclaw-modal-dialog
        label={t(copy().dialog)}
        onModal-cancel={() => (canCancel() ? props.onCancel() : props.onClose())}
      >
        <div class="model-setup-wizard">
          <div class="model-setup-wizard__header">
            <h2>{props.state.authLabel || stepState()?.step.title || t(copy().titleKey)}</h2>
          </div>
          <div class="model-setup-wizard__body">
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
                  <div class="callout warning" role="alert">
                    {warning()}
                  </div>
                </Show>
              )}
            </For>
            <Switch>
              <Match when={props.state.phase === "starting"}>
                <div role="status">{t(copy().starting)}</div>
              </Match>
              <Match when={props.state.phase === "done"}>
                <div role="status">
                  {props.doneMessage ??
                    t(
                      props.mode === "auth"
                        ? "modelSetup.wizard.connected"
                        : "modelSetup.wizard.checking",
                    )}
                </div>
              </Match>
              <Match when={errorState()}>
                {(state) => (
                  <Show
                    when={props.mode === "auth" && state().phase === "error"}
                    fallback={
                      <div class="callout danger" role="alert">
                        {state().message}
                      </div>
                    }
                  >
                    <div class="callout danger model-setup-wizard__error" role="alert">
                      <p class="model-setup-wizard__error-text">{state().message}</p>
                      <div class="model-setup-wizard__error-copy">
                        <CopyButton
                          text={state().message}
                          idleLabel={t("modelSetup.wizard.copy")}
                        />
                      </div>
                    </div>
                  </Show>
                )}
              </Match>
              <Match when={stepState()}>
                {(state) => (
                  <>
                    <Show when={state().validationError}>
                      <div
                        id="model-setup-wizard-validation-error"
                        class="callout danger"
                        role="alert"
                      >
                        {state().validationError}
                      </div>
                    </Show>
                    <WizardStepControls
                      step={state().step}
                      externalAuthInput={state().externalAuthInput}
                      value={props.value}
                      busy={state().busy}
                      inputId="model-setup-wizard-text-input"
                      validationErrorId={
                        state().validationError ? "model-setup-wizard-validation-error" : undefined
                      }
                      confirmAffirmativeLabel={
                        props.mode === "prepare" && state().step.type === "confirm"
                          ? t("modelSetup.wizard.continue")
                          : undefined
                      }
                      leadingAction={
                        <button type="button" class="btn" onClick={() => props.onCancel()}>
                          {t("common.cancel")}
                        </button>
                      }
                      onValueChange={(value) => props.onValueChange(value)}
                      onAnswer={(value) => props.onAnswer(value)}
                    />
                    <Show
                      when={state().busy && !state().step.externalUrl && !state().step.deviceCode}
                    >
                      <div role="status">{t("modelSetup.wizard.working")}</div>
                    </Show>
                  </>
                )}
              </Match>
            </Switch>
          </div>
          <Show when={props.state.phase !== "step"}>
            <div class="model-setup-wizard__footer">
              <button
                type="button"
                class="btn"
                onClick={() => (canCancel() ? props.onCancel() : props.onClose())}
              >
                {t(canCancel() ? "common.cancel" : "common.close")}
              </button>
            </div>
          </Show>
        </div>
      </openclaw-modal-dialog>
    </Show>
  );
}
