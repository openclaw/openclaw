import { html, nothing, type TemplateResult } from "lit";
import { renderCopyButton } from "../../components/copy-button.ts";
import { renderWizardStepControls } from "../../components/wizard-step-controls.ts";
import { t } from "../../i18n/index.ts";
import "../../components/modal-dialog.ts";
import type { ModelSetupWizardState } from "./state.ts";

const WIZARD_TEXT_INPUT_ID = "model-setup-wizard-text-input";

type WizardViewProps = {
  mode: "auth" | "prepare" | "activate";
  state: ModelSetupWizardState;
  refreshWarning: string | null;
  doneMessage?: string;
  cancellationNotice?: string | null;
  value: unknown;
  onValueChange: (value: unknown) => void;
  onAnswer: (value: unknown, includeValue?: boolean) => void;
  onCancel: () => void;
  onClose: () => void;
};

export function renderModelSetupWizard(props: WizardViewProps): TemplateResult | typeof nothing {
  if (props.state.phase === "idle") {
    return nothing;
  }
  const canCancel = props.state.phase === "starting" || props.state.phase === "step";
  return html`
    <openclaw-modal-dialog
      label=${t(
        props.mode === "prepare"
          ? "modelSetup.wizard.prepareDialogLabel"
          : props.mode === "activate"
            ? "modelSetup.heading"
            : "modelSetup.wizard.dialogLabel",
      )}
      @modal-cancel=${canCancel ? props.onCancel : props.onClose}
    >
      <div class="model-setup-wizard">
        <div class="model-setup-wizard__header">
          <h2>
            ${
              props.state.authLabel
                ? props.state.authLabel
                : props.state.phase === "step" && props.state.step.title
                  ? props.state.step.title
                  : t(
                      props.mode === "prepare"
                        ? "modelSetup.wizard.prepareTitle"
                        : props.mode === "activate"
                          ? "modelSetup.heading"
                          : "modelSetup.wizard.title",
                    )
            }
          </h2>
        </div>
        <div class="model-setup-wizard__body">
          ${[props.refreshWarning, props.cancellationNotice].map((warning) =>
            warning ? html`<div class="callout warning" role="alert">${warning}</div>` : nothing,
          )}
          ${
            props.state.phase === "starting"
              ? html`<div role="status">
                  ${t(
                    props.mode === "prepare"
                      ? "modelSetup.wizard.prepareStarting"
                      : props.mode === "activate"
                        ? "modelSetup.wizard.checking"
                        : "modelSetup.wizard.starting",
                  )}
                </div>`
              : props.state.phase === "done"
                ? html`<div role="status">
                    ${props.doneMessage ?? t(props.mode === "auth" ? "modelSetup.wizard.connected" : "modelSetup.wizard.checking")}
                  </div>`
                : props.state.phase === "error" && props.mode === "auth"
                  ? html`<div class="callout danger model-setup-wizard__error" role="alert">
                      <p class="model-setup-wizard__error-text">${props.state.message}</p>
                      <div class="model-setup-wizard__error-copy">
                        ${renderCopyButton(props.state.message, t("modelSetup.wizard.copy"))}
                      </div>
                    </div>`
                  : props.state.phase === "error" || props.state.phase === "cancelled"
                    ? html`<div class="callout danger" role="alert">${props.state.message}</div>`
                    : html`
                        ${
                          props.state.validationError
                            ? html`<div class="callout danger" role="alert">
                                ${props.state.validationError}
                              </div>`
                            : nothing
                        }
                        ${renderWizardStepControls({
                          step: props.state.step,
                          externalAuthInput: props.state.externalAuthInput,
                          value: props.value,
                          busy: props.state.busy,
                          inputId: WIZARD_TEXT_INPUT_ID,
                          confirmAffirmativeLabel:
                            props.mode === "prepare" && props.state.step.type === "confirm"
                              ? t("modelSetup.wizard.continue")
                              : undefined,
                          leadingAction: html`<button
                            type="button"
                            class="btn"
                            @click=${props.onCancel}
                          >
                            ${t("common.cancel")}
                          </button>`,
                          onValueChange: props.onValueChange,
                          onAnswer: props.onAnswer,
                        })}
                        ${
                          props.state.busy &&
                          !props.state.step.externalUrl &&
                          !props.state.step.deviceCode
                            ? html`<div role="status">${t("modelSetup.wizard.working")}</div>`
                            : nothing
                        }
                      `
          }
        </div>
        ${
          props.state.phase === "step"
            ? nothing
            : html`
                <div class="model-setup-wizard__footer">
                  <button
                    type="button"
                    class="btn"
                    @click=${canCancel ? props.onCancel : props.onClose}
                  >
                    ${canCancel ? t("common.cancel") : t("common.close")}
                  </button>
                </div>
              `
        }
      </div>
    </openclaw-modal-dialog>
  `;
}
