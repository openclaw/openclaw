import { html } from "lit";
import { renderWizardStepControls } from "../../components/wizard-step-controls.ts";
import { t } from "../../i18n/index.ts";
import type { CustodianSessionStore } from "./custodian-session-store.ts";
import type { CustodianMessage } from "./transcript.ts";

// The shared wizard keeps its Lit renderer until its own migration is complete.
export function renderCustodianWizardControls(
  store: CustodianSessionStore,
  message: CustodianMessage,
  step: NonNullable<CustodianMessage["step"]>,
) {
  return renderWizardStepControls({
    step,
    value: store.wizardValue,
    busy: !store.canSend,
    inputId: `custodian-wizard-input-${message.id}`,
    sensitiveRevealed: store.wizardSecretVisible,
    onValueChange: (value) => store.setWizardValue(value),
    onAnswer: (value) => store.answerWizardStep(message, value),
    onToggleSensitiveVisibility: () => store.toggleWizardSecretVisibility(),
    leadingAction: store.wizardCancelAvailable
      ? html`<button
          class="btn btn--ghost custodian__wizard-cancel"
          type="button"
          ?disabled=${!store.canSend}
          @click=${() => store.cancelWizardStep(message)}
        >
          ${t("custodian.cancel")}
        </button>`
      : undefined,
  });
}
