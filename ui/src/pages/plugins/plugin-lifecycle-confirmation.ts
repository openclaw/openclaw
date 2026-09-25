import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";

registerPluginManagementEnglish();

export function confirmPluginUninstall(name: string): Promise<boolean> {
  return showConfirmDialog({
    title: t("pluginsPage.removeConfirmTitle", { name }),
    message: t("pluginsPage.removeConfirmMessage"),
    confirmLabel: t("pluginsPage.remove"),
    danger: true,
  });
}
