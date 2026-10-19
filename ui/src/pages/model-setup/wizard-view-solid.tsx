import type { JSX } from "@solidjs/web";
import { createMemo, For, Match, Show, Switch } from "solid-js";
import { CopyButton } from "../../components/solid/copy-button.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { WizardStepControls } from "../../components/wizard-step-controls.tsx";
import { registerModelSetupEnglish } from "../../i18n/locales/en-model-setup.ts";
import "../../components/modal-dialog.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { createPendingFocus } from "../../lib/reactive/pending-focus.ts";
import type { ModelSetupWizardState } from "./state.ts";
import { WIZARD_COPY } from "./wizard-copy.ts";

registerModelSetupEnglish();

export type WizardViewProps = {
  onDialogRef?: (element: import("../../components/modal-dialog.ts").OpenClawModalDialog) => void;
  mode: "auth" | "prepare" | "activate";
  state: ModelSetupWizardState;
  refreshWarning: string | null;
  doneMessage?: string;
  doneDescription?: string;
  doneAction?: { label: string; disabled?: boolean; onClick: () => void };
  cancellationNotice?: string | null;
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
  // Focus the committed wizard step after its identity or completion actions change.
  createPendingFocus(
    () =>
      props.state.phase === "step"
        ? props.state.step.id
        : `${props.state.phase}:${Boolean(props.doneAction)}`,
    {
      requested: () => true,
      focus: () => {
        focusTargets = new Set([...focusTargets].filter((element) => element.isConnected));
        initialFocus()?.focus({ preventScroll: true });
      },
    },
  );
  const copy = createMemo(() => WIZARD_COPY[props.mode]);
  const canCancel = () => props.state.phase === "starting" || props.state.phase === "step";
  const stepState = createMemo(() => (props.state.phase === "step" ? props.state : undefined));
  const errorState = createMemo(() =>
    props.state.phase === "error" || props.state.phase === "cancelled" ? props.state : undefined,
  );
  return (
    <Show when={props.state.phase !== "idle"}>
      <openclaw-modal-dialog
        prop:initialFocus={initialFocus}
        ref={(element) => props.onDialogRef?.(element)}
        label={t(copy().dialog)}
        onModal-cancel={() => (canCancel() ? props.onCancel() : props.onClose())}
      >
        <div
          class={[
            "model-setup-wizard",
            {
              "model-setup-wizard--auth": props.mode === "auth",
              "model-setup-wizard--done": props.state.phase === "done",
            },
          ]}
        >
          <Show when={props.state.phase !== "done"}>
            <div class="model-setup-wizard__header">
              <h2>{props.state.authLabel || stepState()?.step.title || t(copy().titleKey)}</h2>
            </div>
          </Show>
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
                <div class="wizard-step__progress" role="status" aria-busy="true">
                  <span class="wizard-step__spinner" aria-hidden="true" />
                  {t(copy().starting)}
                </div>
              </Match>
              <Match when={props.state.phase === "done"}>
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
                      presentation="model-setup"
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
                      onAutofocusRef={autofocusRef}
                    />
                    <Show
                      when={
                        state().busy &&
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
              </Match>
            </Switch>
          </div>
          <Show when={props.state.phase !== "step"}>
            <openclaw-modal-actions class="model-setup-wizard__footer">
              <Show when={props.state.phase === "done" && props.doneAction}>
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
              <button
                ref={autofocusRef}
                type="button"
                class="btn"
                autofocus={props.state.phase !== "done" || !props.doneAction}
                onClick={() => (canCancel() ? props.onCancel() : props.onClose())}
              >
                {t(canCancel() ? "common.cancel" : "common.close")}
              </button>
            </openclaw-modal-actions>
          </Show>
        </div>
      </openclaw-modal-dialog>
    </Show>
  );
}
