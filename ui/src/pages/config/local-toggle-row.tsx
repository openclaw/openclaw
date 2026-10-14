import type { JSX } from "@solidjs/web";
import { UI_APPEARANCE_DEFAULTS } from "../../app/settings.ts";
import {
  SettingsDefaultDescription,
  SettingsToggleRow,
} from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import type { ConfigProps } from "./view-types.ts";

type LocalToggle =
  | "chatShowTaskProgress"
  | "chatCollapseTaskProgress"
  | "composerHoldToRecord"
  | "sidebarLiveActivity"
  | "sessionDeleteConfirm"
  | "lobsterPetVisits"
  | "lobsterPetSounds";

export function LocalToggleRow(props: {
  config: ConfigProps;
  setting: LocalToggle;
  title: string;
  hint: JSX.Element;
  extraDescription?: JSX.Element;
  disabled?: boolean;
  onAct?: (enabled: boolean) => void;
}) {
  return (
    <SettingsToggleRow
      title={props.title}
      description={
        <>
          {props.hint}
          <br />
          <SettingsDefaultDescription
            value={t(UI_APPEARANCE_DEFAULTS[props.setting] ? "common.enabled" : "common.disabled")}
            overridden={props.config[props.setting] !== UI_APPEARANCE_DEFAULTS[props.setting]}
          />{" "}
          {t("quickSettings.personal.browserOnly")}
          {props.extraDescription}
        </>
      }
      checked={props.config[props.setting]}
      onChange={(enabled) => props.config.onAppearanceChange({ [props.setting]: enabled })}
      onAct={(enabled) => props.onAct?.(enabled)}
      disabled={props.disabled}
    />
  );
}
