import type { JSX } from "@solidjs/web";
import { handleMarkdownCodeBlockClick } from "../../components/markdown-code-blocks.ts";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { SanitizedHtml } from "../../components/solid/sanitized-html.tsx";
import { SettingsPage } from "../../components/solid/settings-ui.tsx";
import { formatUiExternalText } from "../../lib/format-error.ts";
import type { PluginDiscoveryDetailResult, PluginInstallRequest } from "../../lib/plugins/index.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { renderPluginDetailShell as PluginDetailShell } from "./detail-shell.tsx";
import { PluginInstallAction } from "./install-action.tsx";
import type { PluginInstallProgress } from "./install-progress.ts";
import "../../styles/sidebar-markdown.css";
import {
  renderPluginCapabilitySection,
  renderPluginDeclaredCapabilities,
  renderPluginMetadata,
  renderPluginMcpServers,
  renderPluginPublisher,
  renderPluginAskAction,
} from "./overview.tsx";
import { PluginArtTile } from "./plugin-art-tile.tsx";
import { renderPluginRowMessage, type PluginRowMessage } from "./plugin-row-message.tsx";
import { ReasonedDisabledControl } from "./reasoned-disabled-control.tsx";

export type PluginCatalogDetailProps = {
  onAskPlugin?: () => void;
  busy?: boolean;
  installProgress?: PluginInstallProgress;
  message?: PluginRowMessage;
  onContinueInstall?: (request: PluginInstallRequest) => void;
  skillsSection?: JSX.Element;
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

export function renderPluginReadme(readme: string | undefined): JSX.Element {
  const readmeHtml = readme
    ? toSanitizedMarkdownHtml(readme, { mode: "document" })
        .replaceAll("<h1", "<h2")
        .replaceAll("</h1>", "</h2>")
    : null;
  return readme ? (
    <article
      class="plugin-catalog-detail__readme sidebar-markdown"
      onClick={handleMarkdownCodeBlockClick}
    >
      <SanitizedHtml html={readmeHtml ?? ""} class="lit-content" style={{ display: "contents" }} />
    </article>
  ) : (
    <p class="plugin-catalog-detail__empty">{t("pluginsPage.detailNoReadme")}</p>
  );
}

function CatalogDetailContent(props: {
  value: PluginDiscoveryDetailResult;
  state: PluginCatalogDetailProps;
}) {
  const plugin = () => props.value.plugin;
  const detail = () => props.value.detail;
  const installing = () =>
    Boolean(props.state.installProgress && props.state.installProgress.finishedAt === undefined);
  const packageIcon = () =>
    plugin().catalog.imageUrl ? props.state.iconUrls[plugin().catalog.imageUrl!] : undefined;
  const authorIcon = () =>
    detail().author?.imageUrl ? props.state.iconUrls[detail().author!.imageUrl!] : undefined;
  return (
    <PluginDetailShell
      id="plugin-catalog-detail"
      name={plugin().catalog.name}
      summary={plugin().catalog.summary}
      backHref={props.state.backHref}
      backLabel={t("tabs.plugins")}
      onBack={props.state.onBack}
      icon={
        <PluginArtTile
          slug={plugin().id}
          name={plugin().catalog.name}
          options={{
            get iconUrl() {
              return packageIcon();
            },
            get authorIconUrl() {
              return authorIcon();
            },
            get whiteBackground() {
              return plugin().catalog.official && Boolean(packageIcon());
            },
            get loading() {
              return Boolean(
                (plugin().catalog.imageUrl &&
                  props.state.iconLoading?.(plugin().catalog.imageUrl!)) ||
                (detail().author?.imageUrl &&
                  props.state.iconLoading?.(detail().author!.imageUrl!)),
              );
            },
          }}
        />
      }
      titleAction={
        <>
          {plugin().local.action === "install" || installing() ? (
            <ReasonedDisabledControl reason={props.state.installBlockedReason}>
              <PluginInstallAction
                buttonClass="btn oc-action plugin-catalog-detail__install"
                primary
                disabled={!props.state.canInstall}
                busy={Boolean(props.state.busy)}
                progress={props.state.installProgress}
                onInstall={props.state.onInstall}
              />
            </ReasonedDisabledControl>
          ) : undefined}
          {renderPluginAskAction(
            props.state.onAskPlugin,
            plugin().local.action !== "install" && !installing(),
          )}
        </>
      }
      identity={renderPluginPublisher(props.value)}
      sidebar={renderPluginMetadata(props.value)}
      panel={
        <>
          {renderPluginRowMessage(props.state.message, {
            busy: props.state.busy,
            onContinue: props.state.canInstall ? props.state.onContinueInstall : undefined,
          })}
          {renderPluginDeclaredCapabilities(detail().contracts, detail().uiCapabilities)}
          {props.state.skillsSection ??
            renderPluginCapabilitySection(
              t("pluginsPage.detailTabs.skills"),
              detail().skills,
              () => <Icon name="bookOpenText" />,
            )}
          {renderPluginCapabilitySection(
            t("pluginsPage.detailTools"),
            (detail().contracts?.tools ?? []).map((name) => ({ name })),
            () => (
              <Icon name="wrench" />
            ),
          )}
          {renderPluginMcpServers(detail().mcpServers, detail().mcpServerDetails)}
        </>
      }
      readme={detail().readme ? renderPluginReadme(detail().readme) : undefined}
    />
  );
}

export function renderPluginCatalogDetail(props: PluginCatalogDetailProps): JSX.Element {
  return (
    <SettingsPage {...{ wide: true, carapace: true }}>
      {props.error ? (
        <div class="callout danger oc-banner oc-banner-error" role="alert">
          <span>{formatUiExternalText(props.error)}</span>
          <button type="button" class="btn btn--sm" onClick={props.onRetry}>
            {t("pluginsPage.tryAgain")}
          </button>
        </div>
      ) : !props.connected ? (
        <p class="plugin-catalog-detail__empty">{t("pluginsPage.discoveryOffline")}</p>
      ) : props.result ? (
        <CatalogDetailContent value={props.result} state={props} />
      ) : (
        <section
          class="plugin-catalog-detail plugin-catalog-detail--loading"
          aria-label={t("pluginsPage.detailLoading")}
        >
          <div class="plugin-catalog-detail__back skeleton" />
          <div class="plugin-catalog-detail__hero">
            <div class="plugin-catalog-detail__icon skeleton" />
            <div>
              <div class="plugin-catalog-detail__loading-title skeleton" />
              <div class="plugin-catalog-detail__loading-publisher skeleton" />
              <div class="plugin-catalog-detail__loading-summary skeleton" />
            </div>
          </div>
          <div class="plugin-catalog-detail__content">
            <div class="plugin-catalog-detail__main" aria-hidden="true">
              <div class="plugin-catalog-detail__loading-card skeleton" />
              <div class="plugin-catalog-detail__loading-card skeleton" />
            </div>
            <aside class="plugin-catalog-detail__sidebar">
              {renderPluginMetadata(undefined, undefined, undefined, true)}
            </aside>
          </div>
        </section>
      )}
    </SettingsPage>
  );
}
