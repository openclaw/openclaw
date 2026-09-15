import { html, nothing } from "lit";
import { icons } from "../../components/icons.ts";
import "../../components/modal-dialog.ts";
import {
  hasProviderBrandIcon,
  providerIdFromModelRef,
  renderProviderBrandIcon,
} from "../../components/provider-icon.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import type { ModelSetupActivationState } from "./state.ts";

registerSettingsEnglish();

export function renderModelSetupSuccessDialog(
  activation: Extract<ModelSetupActivationState, { phase: "success" }>,
  onOpenChat: () => void,
  onClose: () => void,
  firstRun: boolean,
  returnToModels = false,
) {
  const providerId = providerIdFromModelRef(activation.modelRef);
  const providerIconId = providerId && hasProviderBrandIcon(providerId) ? providerId : null;
  const description =
    activation.warning ?? t("modelSetup.success.body", { modelRef: activation.modelRef });
  const actionLabel = returnToModels
    ? t("modelSetup.discovery.returnToModels")
    : firstRun
      ? t("modelSetup.success.continueSetup")
      : activation.warning
        ? t("tabs.chat")
        : t("modelSetup.success.openChat");
  return html`
    <openclaw-modal-dialog
      label=${t("modelSetup.success.title")}
      description=${description}
      @modal-cancel=${onClose}
    >
      <section class="model-setup-success" role="status">
        <div
          class=${`model-setup-success__icon${providerIconId ? " model-setup-success__icon--provider" : ""}`}
          aria-hidden="true"
        >
          ${
            providerIconId
              ? html`
                  ${renderProviderBrandIcon(providerIconId, {
                    className: "model-setup-success__provider-icon",
                  })}
                  <span class="model-setup-success__status-badge">${icons.check}</span>
                `
              : icons.shieldCheck
          }
        </div>
        <div class="model-setup-success__copy">
          <h2>${t("modelSetup.success.title")}</h2>
          ${activation.warning ? nothing : html`<p>${description}</p>`}
        </div>
        ${
          activation.warning
            ? html`<div class="model-setup-success__warning">${activation.warning}</div>`
            : nothing
        }
        <div class="model-setup-success__summary">
          <span>${t("modelSetup.success.activeModel")}</span>
          <strong>${activation.modelRef}</strong>
          ${
            activation.latencyMs === undefined
              ? nothing
              : html`<span>
                  ${t("modelSetup.success.latency", {
                    latencyMs: String(activation.latencyMs),
                  })}
                </span>`
          }
        </div>
        <footer class="model-setup-success__actions">
          ${
            returnToModels
              ? nothing
              : html`<button type="button" class="btn" @click=${onClose}>
                  ${t("modelSetup.success.stayHere")}
                </button>`
          }
          <button type="button" class="btn primary" autofocus @click=${onOpenChat}>
            ${returnToModels ? nothing : icons.messageSquare} ${actionLabel}
          </button>
        </footer>
      </section>
    </openclaw-modal-dialog>
  `;
}
