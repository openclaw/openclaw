import type { ThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
import { currentThemeBranding } from "../app/theme-branding.ts";
import { solidContent, type LegacyTemplateResult } from "../lit/solid-content.tsx";
import { icons } from "./icons.ts";
import { ThemeBrandIcon } from "./theme-brand-icon.tsx";

export function renderThemeBrandIcon(
  claw: LegacyTemplateResult = icons.lobster,
  branding: ThemeBranding = currentThemeBranding(),
  neutral: LegacyTemplateResult = icons.mark,
) {
  if (branding.brandIcon === "claw") {
    return claw;
  }
  if (branding.brandIcon === "mark") {
    return neutral;
  }
  return solidContent(ThemeBrandIcon, { branding });
}
