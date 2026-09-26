import "./install-action.ts";
import { html, nothing, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { icons } from "../../components/icons.ts";
import { handleMarkdownCodeBlockClick } from "../../components/markdown-code-blocks.ts";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import { renderReasonedDisabledControl } from "../../components/reasoned-disabled-control.ts";
import { renderSettingsPage } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import type { PluginDiscoveryDetailResult, PluginInstallRequest } from "../../lib/plugins/index.ts";
import { renderArtTile } from "./consent-dialog.ts";
import "../../styles/sidebar-markdown.css";
import { renderPluginDetailShell } from "./detail-shell.ts";
import type { PluginInstallProgress } from "./install-progress.ts";
import {
  renderPluginCapabilitySection,
  renderPluginDeclaredCapabilities,
  renderPluginMetadata,
  renderPluginPublisher,
  renderPluginAskAction,
} from "./overview.ts";
import { renderPluginRowMessage, type PluginRowMessage } from "./plugin-row-message.ts";

export type PluginCatalogDetailProps = {
  onAskPlugin?: () => void;
  busy?: boolean;
  installProgress?: PluginInstallProgress;
  message?: PluginRowMessage;
  onContinueInstall?: (request: PluginInstallRequest) => void;
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
  iconLoading?: (url: string) => boolean;
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
  const installing = Boolean(
    props.installProgress && props.installProgress.finishedAt === undefined,
  );
  const packageIcon = plugin.catalog.imageUrl ? props.iconUrls[plugin.catalog.imageUrl] : undefined;
  const authorIcon = detail.author?.imageUrl ? props.iconUrls[detail.author.imageUrl] : undefined;
  return renderPluginDetailShell({
    id: "plugin-catalog-detail",
    name: plugin.catalog.name,
    summary: plugin.catalog.summary,
    backHref: props.backHref,
    backLabel: t("tabs.plugins"),
    onBack: props.onBack,
    icon: renderArtTile(plugin.id, plugin.catalog.name, {
      iconUrl: packageIcon,
      authorIconUrl: authorIcon,
      loading: Boolean(
        (plugin.catalog.imageUrl && props.iconLoading?.(plugin.catalog.imageUrl)) ||
        (detail.author?.imageUrl && props.iconLoading?.(detail.author.imageUrl)),
      ),
    }),
    titleAction: html`${
      plugin.local.action === "install" || installing
        ? renderReasonedDisabledControl(
            props.installBlockedReason,
            html`<openclaw-plugin-install-action
              .buttonClass=${"btn oc-action plugin-catalog-detail__install"}
              .primary=${true}
              .disabled=${!props.canInstall}
              .busy=${Boolean(props.busy)}
              .progress=${props.installProgress}
              .onInstall=${props.onInstall}
            ></openclaw-plugin-install-action>`,
          )
        : nothing
    }${renderPluginAskAction(props.onAskPlugin, plugin.local.action !== "install" && !installing)}`,
    identity: renderPluginPublisher(result),
    sidebar: renderPluginMetadata(result),
    panel: html`${renderPluginRowMessage(props.message, { busy: props.busy, onContinue: props.canInstall ? props.onContinueInstall : undefined })}
    ${renderPluginDeclaredCapabilities(detail.contracts, detail.uiCapabilities)}
    ${props.skillsSection ?? renderPluginCapabilitySection(t("pluginsPage.detailTabs.skills"), detail.skills, icons.bookOpenText)}
    ${renderPluginCapabilitySection(
      t("pluginsPage.detailTools"),
      (detail.contracts?.tools ?? []).map((name) => ({ name })),
      icons.wrench,
    )}
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
                <aside class="plugin-catalog-detail__sidebar">
                  ${renderPluginMetadata(undefined, undefined, undefined, true)}
                </aside>
              </div>
            </section>`,
    { wide: true, carapace: true },
  );
}
