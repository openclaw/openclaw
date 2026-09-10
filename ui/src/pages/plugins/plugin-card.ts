import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";

export type PluginCardAttribution = {
  author?: string;
  official: boolean;
};

export type InstalledPluginState = "enabled" | "disabled" | "needs-setup" | "error";

function installedPluginStatePresentation(state: InstalledPluginState): {
  label: string;
  tone: "ok" | "muted" | "warn" | "danger";
} {
  switch (state) {
    case "enabled":
      return { label: t("pluginsPage.enabled"), tone: "ok" };
    case "disabled":
      return { label: t("pluginsPage.disabled"), tone: "muted" };
    case "needs-setup":
      return { label: t("pluginsPage.setupRequiredNotice"), tone: "warn" };
    case "error":
      return { label: t("pluginsPage.needsAttention"), tone: "danger" };
  }
  return state satisfies never;
}

export function renderPluginStateStatus(
  state: InstalledPluginState,
  className = "installed-plugins-card__status-notice",
): TemplateResult {
  const presentation = installedPluginStatePresentation(state);
  return html`<span
    class="${className} settings-status settings-status--${presentation.tone}"
    data-plugin-state=${state}
    role="img"
    aria-label=${presentation.label}
    title=${presentation.label}
  >
    <span class="settings-status__dot" aria-hidden="true"></span>
  </span>`;
}

export function renderPluginOfficialBadge(): TemplateResult {
  return html`<span
    class="plugin-official-badge"
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

export function renderPluginCardIdentity(params: {
  name: string;
  attribution: PluginCardAttribution;
  linkedAuthor?: boolean;
  showAuthor?: boolean;
  state?: InstalledPluginState;
  subtitle?: string;
}): TemplateResult {
  return html`<div class="installed-plugins-card__identity">
    <div class="plugin-card-title-row">
      <h3>${params.name}</h3>
      ${params.attribution.official ? renderPluginOfficialBadge() : nothing}
      ${params.state ? renderPluginStateStatus(params.state) : nothing}
    </div>
    ${params.subtitle ? renderPluginCardSummary(params.subtitle) : nothing}
    ${
      params.showAuthor === false
        ? nothing
        : renderPluginAuthor(params.attribution.author, { linked: params.linkedAuthor })
    }
  </div>`;
}

export function renderPluginCardSummary(summary: string): TemplateResult {
  return html`<p class="installed-plugins-card__summary">${summary}</p>`;
}
