import { html, nothing } from "lit";
import { icons } from "../../../components/icons.ts";
import { providerDisplayLabel } from "../../../components/provider-icon.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { registerModelControlsEnglish } from "../../../i18n/locales/en-model-controls.ts";
import type { ChatModelCatalogState } from "../../../lib/model-catalog-store.ts";

registerModelControlsEnglish();

export type { ChatModelCatalogState } from "../../../lib/model-catalog-store.ts";

export function renderChatModelCatalogRefresh(state: ChatModelCatalogState | undefined) {
  if (
    !state ||
    (state.status !== "loading" && !(state.status === "ready" && state.pendingProviders?.length))
  ) {
    return nothing;
  }
  const providers = state.pendingProviders?.map(providerDisplayLabel).join(", ");
  const label = providers
    ? t("chat.modelControls.refreshingProviderModels", { providers })
    : t("chat.modelControls.refreshingModels");
  return html`
    <span class="chat-controls__model-refresh" data-chat-model-refresh role="status">
      <openclaw-tooltip .content=${label} .describe=${false} open-on-click>
        <button class="chat-controls__model-refresh-details" type="button" aria-label=${label}>
          <span class="btn__spinner" aria-hidden="true"></span>
        </button>
      </openclaw-tooltip>
      <span class="sr-only">${label}</span>
    </span>
  `;
}

export function renderChatModelCatalogState(
  state: ChatModelCatalogState | undefined,
  hasOptions: boolean,
  hasSelectableOptions: boolean,
  onModelSetup?: () => void,
  errorLabel = t("chat.modelControls.modelsUnavailable"),
  retryTarget?: { disabled: boolean; groupId: string; onRetry: (groupId: string) => unknown },
) {
  if (!state) {
    return nothing;
  }
  const { status } = state;
  const checking = Boolean(state.pendingProviders?.length);
  // A usable catalog refreshes in the search field, without moving the model rows.
  // Keep blocking empty, offline, and failed states explicit below the search.
  if (
    (status === "ready" && hasSelectableOptions && !checking) ||
    (hasOptions && (status === "loading" || (status === "ready" && checking)))
  ) {
    return nothing;
  }
  const label =
    status === "offline"
      ? t("common.offline")
      : status === "error"
        ? hasOptions
          ? t("chat.modelControls.modelsRefreshFailed")
          : errorLabel
        : status === "ready" && !checking
          ? t(
              state.modelSelectionPolicy?.restricted
                ? "chat.modelControls.noPermittedModels"
                : "chat.modelControls.noModelsAvailable",
            )
          : t("chat.modelControls.loadingModels");
  return html`
    <div
      class="chat-controls__model-catalog-state ${
        hasOptions ? "" : "chat-controls__model-catalog-state--empty"
      }"
      data-chat-model-catalog-state=${status}
      role="status"
      aria-live="polite"
    >
      <span class="chat-controls__model-catalog-state-label">
        ${
          status === "error"
            ? icons.alertTriangle
            : status === "loading" || status === "idle" || (status === "ready" && checking)
              ? html`<span class="btn__spinner" aria-hidden="true"></span>`
              : nothing
        }
        <span>${label}</span>
      </span>
      ${
        status === "error" && retryTarget
          ? html`
              <button
                class="chat-controls__model-catalog-action"
                data-chat-model-target-retry=${retryTarget.groupId}
                type="button"
                ?disabled=${retryTarget.disabled}
                @click=${(event: MouseEvent) => {
                  event.stopPropagation();
                  retryTarget.onRetry(retryTarget.groupId);
                }}
              >
                ${t("common.retry")}
              </button>
            `
          : nothing
      }
      ${
        status === "ready" && !hasSelectableOptions && onModelSetup
          ? html`
              <button
                class="chat-controls__model-catalog-action"
                data-chat-model-setup="true"
                type="button"
                @click=${(event: MouseEvent) => {
                  event.stopPropagation();
                  onModelSetup();
                }}
              >
                ${t("chat.modelControls.emptyModelsAction")}
              </button>
            `
          : nothing
      }
    </div>
  `;
}
