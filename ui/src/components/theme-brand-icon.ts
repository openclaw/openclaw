import { html, type TemplateResult } from "lit";
import type { ThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
import { currentThemeBranding } from "../app/theme-branding.ts";
import { icons } from "./icons.ts";
import "./theme-brand-icon.tsx";

export function renderThemeBrandIcon(
  claw: TemplateResult = icons.lobster,
  branding: ThemeBranding = currentThemeBranding(),
  neutral: TemplateResult = icons.mark,
) {
  if (branding.brandIcon === "claw") {
    return claw;
  }
  if (branding.brandIcon === "mark") {
    return neutral;
  }
  return html`<openclaw-theme-brand-icon
    .branding=${branding}
    aria-hidden="true"
  ></openclaw-theme-brand-icon>`;
}
