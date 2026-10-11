import type { JSX } from "@solidjs/web";
import { t } from "../../lib/reactive/i18n.ts";

export type AgentConfigActions = {
  configLoading: boolean;
  configSaving: boolean;
  configDirty: boolean;
  canUpdateConfig: boolean;
  onConfigReload: () => void;
  onConfigSave: () => void;
};

export function AgentConfigButtons(
  props: AgentConfigActions & { children?: JSX.Element; buttonType?: "button" },
) {
  return (
    <>
      <button
        type={props.buttonType}
        class="btn btn--sm"
        disabled={props.configLoading}
        onClick={() => props.onConfigReload()}
      >
        {t("common.reloadConfig")}
      </button>
      {props.children}
      <button
        type={props.buttonType}
        class="btn btn--sm primary"
        disabled={!props.canUpdateConfig || props.configSaving || !props.configDirty}
        onClick={() => props.onConfigSave()}
      >
        {t(props.configSaving ? "common.saving" : "common.save")}
      </button>
    </>
  );
}
