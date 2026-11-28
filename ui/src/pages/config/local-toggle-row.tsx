import type { JSX } from "@solidjs/web";
import { SettingsToggleRow, type SettingIdentifier } from "../../components/solid/settings-ui.tsx";
import { registerPreferencesEnglish } from "../../i18n/locales/en-preferences.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import type { ConfigProps } from "./view-types.ts";

registerEnglishCatalog(registerPreferencesEnglish);

export function LocalToggleRow(props: {
  config: ConfigProps;
  /** The browser preference the row edits; its setting ID is `local.<preference>`. */
  preference:
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
  const setting = (): SettingIdentifier => `local.${props.preference}`;
  return (
    <SettingsToggleRow
      setting={setting()}
      title={props.title}
      description={
        <>
          {props.hint}
          {props.extraDescription}
        </>
      }
      checked={props.config[props.preference]}
      onChange={(enabled) => props.config.onAppearanceChange({ [props.preference]: enabled })}
      onAct={(enabled) => props.onAct?.(enabled)}
      disabled={props.disabled}
    />
  );
}
