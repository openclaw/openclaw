import { html, nothing, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { icons } from "../../components/icons.ts";
import { imageWithFallback } from "../../components/image-with-fallback.ts";
import { handleMarkdownCodeBlockClick } from "../../components/markdown-code-blocks.ts";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import { renderReasonedDisabledControl } from "../../components/reasoned-disabled-control.ts";
import { renderSettingsPage } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import type { PluginDiscoveryDetailResult } from "../../lib/plugins/index.ts";
import "../../styles/sidebar-markdown.css";
import { renderPluginDetailShell } from "./detail-shell.ts";
import {
  renderPluginCapabilitySection,
  renderPluginMetadata,
  renderPluginPublisher,
  renderPluginAskAction,
} from "./overview.ts";

export type PluginCatalogDetailProps = {
  onAskPlugin?: () => void;
  skillsSection?: TemplateResult;
  connected: boolean;
  result: PluginDiscoveryDetailResult | null;
  error: string | null;
  backHref: string;
  onBack: () => void;
  onRetry: () => void;
  canInstall: boolean;
  installBlockedReason: string | null;
  onInstall: () => void;
  iconUrls: Readonly<Record<string, string>>;
};

export function renderPluginReadme(readme: string | undefined): TemplateResult {
  const readmeHtml = readme
    ? toSanitizedMarkdownHtml(readme, { mode: "document" })
        .replaceAll("<h1", "<h2")
        .replaceAll("</h1>", "</h2>")
    : null;
  return readme
    ? html`<article
        class="plugin-catalog-detail__readme sidebar-markdown"
        @click=${handleMarkdownCodeBlockClick}
      >
        ${unsafeHTML(readmeHtml)}
      </article>`
    : html`<p class="plugin-catalog-detail__empty">${t("pluginsPage.detailNoReadme")}</p>`;
}

function renderDetail(result: PluginDiscoveryDetailResult, props: PluginCatalogDetailProps) {
  const { plugin, detail } = result;
  const packageIcon = plugin.catalog.imageUrl ? props.iconUrls[plugin.catalog.imageUrl] : undefined;
  return renderPluginDetailShell({
    id: "plugin-catalog-detail",
    name: plugin.catalog.name,
    summary: plugin.catalog.summary,
    backHref: props.backHref,
    backLabel: t("tabs.plugins"),
    onBack: props.onBack,
    icon: html`${imageWithFallback(packageIcon, (url, onError) => (url ? html`<img src=${url} alt="" @error=${onError} />` : icons.box))}`,
    titleAction: html`${
      plugin.local.action === "install"
        ? renderReasonedDisabledControl(
            props.installBlockedReason,
            html`<button
              type="button"
              class="btn primary oc-action oc-action-primary plugin-catalog-detail__install"
              ?disabled=${!props.installBlockedReason && !props.canInstall}
              aria-disabled=${!props.canInstall ? "true" : nothing}
              @click=${() => {
                if (props.canInstall) {
                  props.onInstall();
                }
              }}
            >
              ${t("pluginsPage.install")}
            </button>`,
          )
        : nothing
    }${renderPluginAskAction(props.onAskPlugin)}`,
    identity: renderPluginPublisher(result),
    sidebar: renderPluginMetadata(result),
    panel: html`${props.skillsSection ?? renderPluginCapabilitySection(t("pluginsPage.detailTabs.skills"), detail.skills, icons.book)}
    ${renderPluginCapabilitySection(
      t("pluginsPage.detailMcpServers"),
      detail.mcpServers.map((name) => ({ name })),
      icons.plug,
    )}`,
    readme: detail.readme ? renderPluginReadme(detail.readme) : undefined,
  });
}

export function renderPluginCatalogDetail(props: PluginCatalogDetailProps): TemplateResult {
  return renderSettingsPage(
    props.error
      ? html`<div class="callout danger oc-banner oc-banner-error" role="alert">
          <span>${formatUiExternalText(props.error)}</span>
          <button type="button" class="btn btn--sm" @click=${props.onRetry}>
            ${t("pluginsPage.tryAgain")}
          </button>
        </div>`
      : !props.connected
        ? html`<p class="plugin-catalog-detail__empty">${t("pluginsPage.discoveryOffline")}</p>`
        : props.result
          ? renderDetail(props.result, props)
          : html`<section
              class="plugin-catalog-detail plugin-catalog-detail--loading"
              aria-label=${t("pluginsPage.detailLoading")}
            >
              <div class="plugin-catalog-detail__back skeleton"></div>
              <div class="plugin-catalog-detail__hero">
                <div class="plugin-catalog-detail__icon skeleton"></div>
                <div>
                  <div class="plugin-catalog-detail__loading-title skeleton"></div>
                  <div class="plugin-catalog-detail__loading-publisher skeleton"></div>
                  <div class="plugin-catalog-detail__loading-summary skeleton"></div>
                </div>
              </div>
              <div class="plugin-catalog-detail__content">
                <div class="plugin-catalog-detail__panel" aria-hidden="true">
                  <div class="plugin-catalog-detail__loading-card skeleton"></div>
                  <div class="plugin-catalog-detail__loading-card skeleton"></div>
                </div>
              </div>
            </section>`,
    { wide: true, carapace: true },
  );
}
