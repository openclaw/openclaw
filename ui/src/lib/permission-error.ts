import { registerPermissionErrorsEnglish } from "../i18n/locales/en-permission-errors.ts";
import { registerEnglishCatalog, t } from "./reactive/i18n.ts";

registerEnglishCatalog(registerPermissionErrorsEnglish);

export function formatMissingOperatorReadScopeMessage(feature: string): string {
  return t("runtimeErrors.permissionDenied", {
    feature: t(`runtimeErrors.permissionFeatures.${feature}`),
  });
}
