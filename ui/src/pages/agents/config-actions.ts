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
  return [false, true].map(
    (save) => html`
      ${save ? beforeSave : nothing}
      <button
        type=${buttonType ?? nothing}
        class=${save ? "btn btn--sm primary" : "btn btn--sm"}
        ?disabled=${save ? !props.canUpdateConfig || props.configSaving || !props.configDirty : props.configLoading}
        @click=${save ? props.onConfigSave : props.onConfigReload}
      >
        ${t(save ? (props.configSaving ? "common.saving" : "common.save") : "common.reloadConfig")}
      </button>
    `,
  );
}
