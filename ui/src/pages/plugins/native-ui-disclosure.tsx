import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerPluginManagementEnglish);

/** Information about plugin code and contents, not an additional permission or consent gate. */
export function PluginNativeUiDisclosure(props: { variant?: "install" | "bundle" }) {
  const copy = () =>
    props.variant === "install"
      ? "installTrust"
      : props.variant === "bundle"
        ? "bundleTrust"
        : "nativeUi";
  return (
    <aside
      class="plugin-native-ui-disclosure callout"
      aria-label={t(`pluginsPage.${copy()}.title`)}
    >
      <strong>{t(`pluginsPage.${copy()}.title`)}</strong>
      <div class="card-sub">{t(`pluginsPage.${copy()}.description`)}</div>
    </aside>
  );
}
