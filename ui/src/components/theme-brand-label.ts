import { t } from "../i18n/index.ts";

/** Help belongs to the selected regular agent, not the product brand. */
export function askBrandLabel(translate: typeof t = t): string {
  return translate("nav.askOpenClaw");
}
