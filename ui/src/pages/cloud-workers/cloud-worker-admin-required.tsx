import { SettingsSection, SettingsUnavailable } from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";

export function CloudEnvironmentsAdminRequired() {
  return (
    <SettingsSection>
      <SettingsUnavailable message={t("cloudWorkersPage.environments.adminRequired")} />
    </SettingsSection>
  );
}
