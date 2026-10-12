import { html, nothing, type TemplateResult } from "lit";
import { renderCopyButton } from "../../components/copy-button.ts";
import { renderWizardStepControls } from "../../components/wizard-step-controls.ts";
import { t } from "../../i18n/index.ts";
import "../../components/modal-dialog.ts";
import type { ModelSetupWizardState } from "./state.ts";
import { WIZARD_COPY } from "./wizard-copy.ts";

export type WizardViewProps = {
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
  const { state } = props;
  if (state.phase === "idle") {
    return nothing;
  }
  const canCancel = state.phase === "starting" || state.phase === "step";
  const copy = WIZARD_COPY[props.mode];
  let content: TemplateResult;
  if (state.phase === "starting") {
    content = html`<div role="status">${t(copy.starting)}</div>`;
  } else if (state.phase === "done") {
    content = html`<div role="status">
      ${props.doneMessage ?? t(props.mode === "auth" ? "modelSetup.wizard.connected" : "modelSetup.wizard.checking")}
    </div>`;
  } else if (state.phase === "error" && props.mode === "auth") {
    content = html`<div class="callout danger model-setup-wizard__error" role="alert">
      <p class="model-setup-wizard__error-text">${state.message}</p>
      <div class="model-setup-wizard__error-copy">
        ${renderCopyButton(state.message, t("modelSetup.wizard.copy"))}
      </div>
    </div>`;
  } else if (state.phase === "error" || state.phase === "cancelled") {
    content = html`<div class="callout danger" role="alert">${state.message}</div>`;
  } else {
    content = html`
      ${
        state.validationError
          ? html`<div id="model-setup-wizard-validation-error" class="callout danger" role="alert">
              ${state.validationError}
            </div>`
          : nothing
      }
      ${renderWizardStepControls({
        step: state.step,
        externalAuthInput: state.externalAuthInput,
        value: props.value,
        busy: state.busy,
        inputId: "model-setup-wizard-text-input",
        validationErrorId: state.validationError
          ? "model-setup-wizard-validation-error"
          : undefined,
        confirmAffirmativeLabel:
          props.mode === "prepare" && state.step.type === "confirm"
            ? t("modelSetup.wizard.continue")
            : undefined,
        leadingAction: html`<button type="button" class="btn" @click=${props.onCancel}>
          ${t("common.cancel")}
        </button>`,
        onValueChange: props.onValueChange,
        onAnswer: props.onAnswer,
      })}
      ${
        state.busy && !state.step.externalUrl && !state.step.deviceCode
          ? html`<div role="status">${t("modelSetup.wizard.working")}</div>`
          : nothing
      }
    `;
  }
  return html`
    <openclaw-modal-dialog
      label=${t(copy.dialog)}
      @modal-cancel=${canCancel ? props.onCancel : props.onClose}
    >
      <div class="model-setup-wizard">
        <div class="model-setup-wizard__header">
          <h2>
            ${state.authLabel || (state.phase === "step" && state.step.title) || t(copy.titleKey)}
          </h2>
        </div>
        <div class="model-setup-wizard__body">
          ${[
            props.refreshWarning,
            props.cancellationNotice,
            state.phase === "starting" ? state.notice : undefined,
          ].map((warning) =>
            warning ? html`<div class="callout warning" role="alert">${warning}</div>` : nothing,
          )}
          ${content}
        </div>
        ${
          state.phase === "step"
            ? nothing
            : html`
                <div class="model-setup-wizard__footer">
                  <button
                    type="button"
                    class="btn"
                    @click=${canCancel ? props.onCancel : props.onClose}
                  >
                    ${t(canCancel ? "common.cancel" : "common.close")}
                  </button>
                </div>
              `
        }
      </div>
    </openclaw-modal-dialog>
  `;
}
