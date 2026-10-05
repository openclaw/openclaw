import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";

export type AgentConfigActions = {
  configLoading: boolean;
  configSaving: boolean;
  configDirty: boolean;
  canUpdateConfig: boolean;
  onConfigReload: () => void;
  onConfigSave: () => void;
};

export function renderAgentConfigActions(
  props: AgentConfigActions,
  beforeSave: TemplateResult | typeof nothing = nothing,
  buttonType?: "button",
) {
  return html`
    <button
      type=${buttonType ?? nothing}
      class="btn btn--sm"
      ?disabled=${props.configLoading}
      @click=${props.onConfigReload}
    >
      ${t("common.reloadConfig")}
    </button>
    ${beforeSave}
    <button
      type=${buttonType ?? nothing}
      class="btn btn--sm primary"
      ?disabled=${!props.canUpdateConfig || props.configSaving || !props.configDirty}
      @click=${props.onConfigSave}
    >
      ${props.configSaving ? t("common.saving") : t("common.save")}
    </button>
  `;
}
