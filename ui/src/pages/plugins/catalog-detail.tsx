import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { handleMarkdownCodeBlockClick } from "../../components/markdown-code-blocks.ts";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { SanitizedHtml } from "../../components/solid/sanitized-html.tsx";
import {
  SettingsEmpty,
  SettingsGroup,
  SettingsPage,
  SettingsSection,
  SettingsUnavailable,
} from "../../components/solid/settings-ui.tsx";
import { formatUiExternalText } from "../../lib/format-error.ts";
import type { PluginDiscoveryDetailResult, PluginInstallRequest } from "../../lib/plugins/index.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { PluginDetailLoadingHero } from "./detail-loading-hero.tsx";
import { renderPluginDetailShell as PluginDetailShell } from "./detail-shell.tsx";
import { PluginInstallAction, type PluginInstallActionProps } from "./install-action.tsx";
import "../../styles/sidebar-markdown.css";
import type { PluginInstallProgress } from "./install-progress.ts";
import {
  renderPluginContentCapabilities,
  renderPluginMetadata,
  renderPluginPublisher,
  renderPluginAskAction,
  renderPublisherIdentity,
} from "./overview.tsx";
import { renderPluginRowMessage, type PluginRowMessage } from "./plugin-row-message.tsx";
import type { PluginCatalogIdentity } from "./plugins-page-model.ts";
import { PluginArtTile } from "./presentation.tsx";
import { ReasonedDisabledControl } from "./reasoned-disabled-control.tsx";
import { PluginRecommendedPrompts } from "./recommended-prompts.tsx";

export type PluginCatalogDetailProps = {
  registerRemovalHeading?: (heading: HTMLHeadingElement) => () => void;
  registerInstallAction?: PluginInstallActionProps["registerInstallAction"];
  registerIcon?: (readId: () => string) => () => void;
  onAskPlugin?: () => void;
  onSelectPrompt?: (prompt: string) => void;
  promptBusy?: boolean;
  promptBlockedReason?: string | null;
  busy?: boolean;
  installProgress?: PluginInstallProgress;
  message?: PluginRowMessage;
  onContinueInstall?: (request: PluginInstallRequest) => void;
  skillsSection?: JSX.Element;
  connected: boolean;
  preview?: PluginCatalogIdentity;
  result: PluginDiscoveryDetailResult | null;
  error?: string;
  backHref: string;
  onBack: () => void;
  onRetry: () => void;
  canInstall: boolean;
  installTitle?: string;
  installBlockedReason: string | null;
  onInstall: () => void;
  iconUrls: Readonly<Record<string, string>>;
  iconLoading?: (url: string) => boolean;
};

export function renderPluginReadme(readme: string | undefined): JSX.Element {
  return readme ? (
    <article
      class="plugin-catalog-detail__readme sidebar-markdown"
      onClick={handleMarkdownCodeBlockClick}
    >
      <SanitizedHtml
        html={toSanitizedMarkdownHtml(readme, { mode: "document" })
          .replaceAll("<h1", "<h2")
          .replaceAll("</h1>", "</h2>")}
        class="lit-content"
        style={{ display: "contents" }}
      />
    </article>
  ) : (
    <SettingsGroup>
      <SettingsEmpty message={t("pluginsPage.detailNoReadme")} />
    </SettingsGroup>
  );
}

function CatalogDetailContent(props: {
  identity: PluginCatalogIdentity;
  state: PluginCatalogDetailProps;
}) {
  let installButton: HTMLButtonElement | undefined;
  const catalog = () => props.identity.catalog;
  const failed = () => props.state.error !== undefined;
  const result = () => (failed() ? null : props.state.result);
  const installing = () =>
    Boolean(props.state.installProgress && props.state.installProgress.finishedAt === undefined);
  const iconUrl = () => catalog().imageUrl;
  const authorIconUrl = () => props.state.result?.detail.author?.imageUrl;
  const artwork = (url?: string) => (url ? props.state.iconUrls[url] : undefined);
  const artworkLoading = (url?: string) => Boolean(url && props.state.iconLoading?.(url));
  const panel = () => {
    const error = props.state.error;
    if (error !== undefined) {
      return <CatalogDetailError message={error} onRetry={props.state.onRetry} />;
    }
    const detail = result()?.detail;
    if (!detail) {
      return (
        <div aria-hidden="true">
          <CatalogDetailLoadingCards />
        </div>
      );
    }
    return renderPluginContentCapabilities({
      contracts: detail.contracts,
      uiCapabilities: detail.uiCapabilities,
      skillsSection: props.state.skillsSection,
      skills: detail.skills,
      tools: (detail.contracts?.tools ?? []).map((name) => ({ name })),
      mcpServers: detail.mcpServers,
      mcpServerDetails: detail.mcpServerDetails,
    });
  };
  return (
    <PluginDetailShell
      registerRemovalHeading={props.state.registerRemovalHeading}
      id="plugin-catalog-detail"
      name={catalog().name}
      summary={catalog().summary}
      backHref={props.state.backHref}
      backLabel={t("tabs.plugins")}
      onBack={props.state.onBack}
      icon={
        <PluginArtTile
          neutralFallback
          registerIcon={props.state.registerIcon}
          slug={props.identity.id}
          name={catalog().name}
          iconUrl={artwork(iconUrl())}
          authorIconUrl={artwork(authorIconUrl())}
          whiteBackground={catalog().official && Boolean(artwork(iconUrl()))}
          loading={artworkLoading(iconUrl()) || artworkLoading(authorIconUrl())}
        />
      }
      rail
      titleAction={
        <Show when={result()}>
          {(loaded) => (
            <>
              {renderPluginAskAction(
                props.state.onAskPlugin,
                loaded().plugin.local.action !== "install" && !installing(),
              )}
              {loaded().plugin.local.action === "install" || installing() ? (
                <ReasonedDisabledControl
                  reason={props.state.installBlockedReason}
                  descriptionTarget={() => installButton ?? null}
                >
                  <PluginInstallAction
                    registerInstallAction={props.state.registerInstallAction}
                    onButtonRef={(element) => (installButton = element)}
                    buttonClass="btn oc-action plugin-catalog-detail__install"
                    primary
                    title={props.state.installTitle}
                    disabled={!props.state.canInstall}
                    busy={Boolean(props.state.busy)}
                    progress={props.state.installProgress}
                    onInstall={props.state.onInstall}
                  />
                </ReasonedDisabledControl>
              ) : undefined}
            </>
          )}
        </Show>
      }
      identity={
        props.state.result
          ? renderPluginPublisher(props.state.result)
          : renderPublisherIdentity({
              handle: catalog().author,
              catalogOfficial: catalog().official,
            })
      }
      sidebar={
        failed()
          ? undefined
          : renderPluginMetadata(result() ?? undefined, undefined, undefined, !result())
      }
      recommendations={
        <Show when={result()}>
          {(loaded) => (
            <PluginRecommendedPrompts
              id={loaded().plugin.id}
              name={loaded().plugin.catalog.name}
              prompts={loaded().detail.recommendedPrompts}
              iconUrl={artwork(iconUrl())}
              registerIcon={props.state.registerIcon}
              busy={props.state.busy || props.state.promptBusy}
              disabled={Boolean(props.state.promptBlockedReason)}
              disabledReason={props.state.promptBlockedReason}
              onSelect={props.state.onSelectPrompt}
            />
          )}
        </Show>
      }
      notices={
        result()
          ? renderPluginRowMessage(props.state.message, {
              busy: props.state.busy,
              onContinue: props.state.canInstall ? props.state.onContinueInstall : undefined,
            })
          : undefined
      }
      panel={panel()}
      readme={result()?.detail.readme ? renderPluginReadme(result()?.detail.readme) : undefined}
    />
  );
}

function CatalogDetailLoadingCards() {
  return (
    <>
      <div class="plugin-catalog-detail__loading-card skeleton" />
      <div class="plugin-catalog-detail__loading-card skeleton" />
    </>
  );
}

function CatalogDetailLoading() {
  return (
    <section
      class="plugin-catalog-detail plugin-catalog-detail--rail plugin-catalog-detail--loading"
      aria-label={t("pluginsPage.detailLoading")}
    >
      <div class="plugin-catalog-detail__back skeleton" />
      <PluginDetailLoadingHero />
      <div class="plugin-catalog-detail__content">
        <div class="plugin-catalog-detail__main" aria-hidden="true">
          <CatalogDetailLoadingCards />
        </div>
        <aside class="plugin-catalog-detail__sidebar">
          {renderPluginMetadata(undefined, undefined, undefined, true)}
        </aside>
      </div>
    </section>
  );
}

function CatalogDetailError(props: { message: string; onRetry: () => void }) {
  return (
    <InlineAlert
      tone="danger"
      action={
        <button type="button" class="btn btn--sm" onClick={() => props.onRetry()}>
          {t("pluginsPage.tryAgain")}
        </button>
      }
    >
      {formatUiExternalText(props.message)}
    </InlineAlert>
  );
}

export function renderPluginCatalogDetail(props: PluginCatalogDetailProps): JSX.Element {
  return (
    <SettingsPage {...{ wide: true, carapace: true }}>
      {!props.connected ? (
        <SettingsSection>
          <SettingsUnavailable message={t("pluginsPage.discoveryOffline")} />
        </SettingsSection>
      ) : (
        <Show
          when={props.result?.plugin ?? props.preview}
          fallback={
            props.error === undefined ? (
              <CatalogDetailLoading />
            ) : (
              <CatalogDetailError message={props.error} onRetry={props.onRetry} />
            )
          }
        >
          {(identity) => <CatalogDetailContent identity={identity()} state={props} />}
        </Show>
      )}
    </SettingsPage>
  );
}
