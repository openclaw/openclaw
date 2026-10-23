import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import "./native-ui-disclosure.css";

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
    <aside class="plugin-native-ui-disclosure" aria-label={t(`pluginsPage.${copy()}.title`)}>
      <strong>{t(`pluginsPage.${copy()}.title`)}</strong>
      <p>{t(`pluginsPage.${copy()}.description`)}</p>
    </aside>
  );
}
