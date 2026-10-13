import { currentThemeBranding } from "../app/theme-branding.ts";
import { t } from "../i18n/index.ts";

export function askBrandLabel(): string {
  const brand = currentThemeBranding().brandName;
  return brand === "OpenClaw" ? t("nav.askOpenClaw") : t("nav.askBrand", { brand });
}
