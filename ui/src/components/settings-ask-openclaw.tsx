import { i18nRevision } from "../lib/reactive/i18n.ts";
import { themeBrandingProjection } from "../lib/reactive/theme-branding.ts";
import { CUSTODIAN_PANEL_TOGGLE_EVENT } from "./panel-toggle-contract.ts";
import { ThemeBrandingIcon } from "./theme-brand-icon.tsx";
import { askBrandLabel } from "./theme-brand-label.ts";
import "./settings-ask-openclaw.css";

/** Floats over every Settings page; its dock opens beside the page instead of leaving it. */
export function SettingsAskOpenClaw() {
  return (
    <button
      type="button"
      class="settings-ask"
      onClick={() => window.dispatchEvent(new CustomEvent(CUSTODIAN_PANEL_TOGGLE_EVENT))}
    >
      <span class="settings-ask__mascot" aria-hidden="true">
        <ThemeBrandingIcon />
      </span>
      <span class="settings-ask__label">
        {(i18nRevision(), themeBrandingProjection.read(), askBrandLabel())}
      </span>
    </button>
  );
}
