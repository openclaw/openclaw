import { html, nothing } from "lit";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";

export type ChatModelCatalogState = {
  hasSnapshot: boolean;
  refreshFailed?: boolean;
  status: "idle" | "loading" | "ready" | "error" | "offline";
};

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
  const status = state.status === "ready" && state.refreshFailed ? "error" : state.status;
  if (status === "ready" && hasSelectableOptions) {
    return nothing;
  }
  const label =
    status === "offline"
      ? t("common.offline")
      : status === "error"
        ? hasOptions
          ? t("chat.modelControls.modelsRefreshFailed")
          : errorLabel
        : status === "ready"
          ? t("chat.modelControls.noModelsAvailable")
          : t("chat.modelControls.loadingModels");
  return html`
    <div
      class="chat-controls__model-catalog-state ${
        hasOptions ? "" : "chat-controls__model-catalog-state--empty"
      }"
      data-chat-model-catalog-state=${status}
      aria-live="polite"
    >
      <span class="chat-controls__model-catalog-state-label">
        ${status === "error" ? icons.alertTriangle : nothing}
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
