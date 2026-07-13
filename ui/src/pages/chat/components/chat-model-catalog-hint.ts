import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";

export function formatCombinedPickerModelLabel(label: string): string {
  const match = /^Default \((.+)\)$/u.exec(label);
  return match?.[1] ?? label;
}

export function formatCombinedPickerThinkingLabel(label: string): string {
  return label.replace(/^Inherited:\s*/u, "");
}

export function renderChatModelCatalogHint(modelSettingsHref?: string) {
  return modelSettingsHref
    ? html`
        <div class="chat-controls__catalog-hint" role="note">
          <span>${t("chat.selectors.replaceModeHint")}</span>
          <a href=${modelSettingsHref}>${t("chat.selectors.manageModels")}</a>
        </div>
      `
    : nothing;
}
