import { currentThemeBranding } from "../app/theme-branding.ts";
import { t } from "../i18n/index.ts";

export function askBrandLabel(translate: typeof t = t): string {
  const brand = currentThemeBranding().brandName;
  return brand === "OpenClaw" ? translate("nav.askOpenClaw") : translate("nav.askBrand", { brand });
}
