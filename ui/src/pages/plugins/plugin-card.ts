import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";

registerPluginManagementEnglish();

export type InstalledPluginState = "enabled" | "disabled" | "needs-setup" | "error";

const INSTALLED_PLUGIN_STATUS = {
  enabled: ["pluginsPage.enabled", "ok"],
  disabled: ["pluginsPage.disabled", "muted"],
  "needs-setup": ["pluginsPage.setupRequiredNotice", "warn"],
  error: ["pluginsPage.needsAttention", "danger"],
} as const satisfies Record<InstalledPluginState, readonly [string, string]>;

export function renderPluginStateStatus(
  state: InstalledPluginState,
  className: string,
): TemplateResult {
  const [labelKey, tone] = INSTALLED_PLUGIN_STATUS[state];
  const label = t(labelKey);
  return html`<span
    class="${className} settings-status settings-status--${tone}"
    data-plugin-state=${state}
    role="img"
    aria-label=${label}
    title=${label}
  >
    <span class="settings-status__dot" aria-hidden="true"></span>
  </span>`;
}

export function renderPluginOfficialBadge(): TemplateResult {
  return html`<span
    class="plugin-official-badge"
    role="img"
    aria-label=${t("pluginsPage.official")}
    title=${t("pluginsPage.official")}
    >${icons.badgeCheck}</span
  >`;
}

export function renderPluginAuthor(
  author: string | undefined,
  options: { linked?: boolean } = {},
): TemplateResult | typeof nothing {
  if (!author) {
    return nothing;
  }
  const handle = author.replace(/^@+/, "");
  const label = `@${handle}`;
  return options.linked
    ? html`<a
        class="plugin-card-author plugin-card-author--linked"
        href=${`https://clawhub.ai/${encodeURIComponent(handle)}`}
        target="_blank"
        rel="noopener noreferrer"
        >${label}</a
      >`
    : html`<span class="plugin-card-author">${label}</span>`;
}

export function renderPluginCardSummary(summary: string): TemplateResult {
  return html`<p class="installed-plugins-card__summary">${summary}</p>`;
}
