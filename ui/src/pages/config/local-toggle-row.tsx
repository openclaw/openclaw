import type { JSX } from "@solidjs/web";
import { SettingsToggleRow } from "../../components/solid/settings-ui.tsx";
import { registerPreferencesEnglish } from "../../i18n/locales/en-preferences.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import type { ConfigProps } from "./view-types.ts";

registerEnglishCatalog(registerPreferencesEnglish);

export function LocalToggleRow(props: {
  config: ConfigProps;
  setting:
    | "chatShowTaskProgress"
    | "chatCollapseTaskProgress"
    | "composerHoldToRecord"
    | "sidebarLiveActivity"
    | "sessionDeleteConfirm"
    | "lobsterPetVisits"
    | "lobsterPetSounds";
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
