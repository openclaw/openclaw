import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { pluginInstallRequestName, type PluginInstallRequest } from "../../lib/plugins/index.ts";

registerPluginManagementEnglish();

export function confirmPluginInstall(request: PluginInstallRequest): Promise<boolean> {
  const name = pluginInstallRequestName(request);
  return showConfirmDialog({
    title: t("pluginsPage.installConfirmTitle", { name }),
    message: t("pluginsPage.installConfirmMessage"),
    confirmLabel: t("pluginsPage.install"),
  });
}

export function confirmPluginUninstall(name: string): Promise<boolean> {
  return showConfirmDialog({
    title: t("pluginsPage.removeConfirmTitle", { name }),
    message: t("pluginsPage.removeConfirmMessage"),
    confirmLabel: t("pluginsPage.remove"),
    danger: true,
  });
}
