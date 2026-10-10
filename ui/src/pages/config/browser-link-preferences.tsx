import { SettingsToggleRow } from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";

export function BrowserLinkPreferencesRow(props: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <SettingsToggleRow
      title={t("browserLinkPreferences.openInControlUi")}
      checked={props.enabled}
      onChange={props.onChange}
    />
  );
}
