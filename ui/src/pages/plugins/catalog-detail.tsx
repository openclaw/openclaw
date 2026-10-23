import type { JSX } from "@solidjs/web";
import { createMemo, Errored, Loading, Show } from "solid-js";
import { handleMarkdownCodeBlockClick } from "../../components/markdown-code-blocks.ts";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import { SanitizedHtml } from "../../components/solid/sanitized-html.tsx";
import { SettingsPage } from "../../components/solid/settings-ui.tsx";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import type { PluginDiscoveryDetailResult, PluginInstallRequest } from "../../lib/plugins/index.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { PluginArtTile } from "./consent-dialog.tsx";
import { PluginDetailLoadingHero } from "./detail-loading-hero.tsx";
import { renderPluginDetailShell as PluginDetailShell } from "./detail-shell.tsx";
import { PluginInstallAction, type PluginInstallActionProps } from "./install-action.tsx";
import "../../styles/sidebar-markdown.css";
import type { PluginInstallProgress } from "./install-progress.ts";
import { PluginNativeUiDisclosure } from "./native-ui-disclosure.tsx";
import {
  renderPluginContentCapabilities,
  renderPluginMetadata,
  renderPluginPublisher,
  renderPluginAskAction,
} from "./overview.tsx";
import { renderPluginRowMessage, type PluginRowMessage } from "./plugin-row-message.tsx";
import type { PluginDetailRead } from "./plugins-detail-reads.ts";
import { ReasonedDisabledControl } from "./reasoned-disabled-control.tsx";

export type PluginCatalogDetailProps = {
  registerRemovalHeading?: (heading: HTMLHeadingElement) => () => void;
  registerInstallAction?: PluginInstallActionProps["registerInstallAction"];
  registerIcon?: (readId: () => string) => () => void;
  onAskPlugin?: () => void;
  busy?: boolean;
  installProgress?: PluginInstallProgress;
  message?: PluginRowMessage;
  onContinueInstall?: (request: PluginInstallRequest) => void;
  skillsSection?: JSX.Element;
  connected: boolean;
  result: PluginDiscoveryDetailResult | null;
  read: PluginDetailRead;
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
    <p class="plugin-catalog-detail__empty">{t("pluginsPage.detailNoReadme")}</p>
  );
}

function CatalogDetailContent(props: {
  value: PluginDiscoveryDetailResult;
  state: PluginCatalogDetailProps;
}) {
  let installButton: HTMLButtonElement | undefined;
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
      registerRemovalHeading={props.state.registerRemovalHeading}
      id="plugin-catalog-detail"
      name={plugin().catalog.name}
      summary={plugin().catalog.summary}
      backHref={props.state.backHref}
      backLabel={t("tabs.plugins")}
      onBack={props.state.onBack}
      icon={
        <PluginArtTile
          registerIcon={props.state.registerIcon}
          slug={plugin().id}
          name={plugin().catalog.name}
          iconUrl={packageIcon()}
          authorIconUrl={authorIcon()}
          whiteBackground={plugin().catalog.official && Boolean(packageIcon())}
          loading={Boolean(
            (plugin().catalog.imageUrl && props.state.iconLoading?.(plugin().catalog.imageUrl!)) ||
            (detail().author?.imageUrl && props.state.iconLoading?.(detail().author!.imageUrl!)),
          )}
        />
      }
      notice={
        plugin().local.action === "install" || installing() ? (
          <PluginNativeUiDisclosure
            variant={plugin().catalog.family === "bundle-plugin" ? "bundle" : "install"}
          />
        ) : undefined
      }
      titleAction={
        <>
          {plugin().local.action === "install" || installing() ? (
            <ReasonedDisabledControl
              reason={props.state.installBlockedReason}
              descriptionTarget={() => installButton ?? null}
            >
              <PluginInstallAction
                registerInstallAction={props.state.registerInstallAction}
                onButtonRef={(element) => (installButton = element)}
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
          {renderPluginContentCapabilities({
            contracts: detail().contracts,
            uiCapabilities: detail().uiCapabilities,
            skillsSection: props.state.skillsSection,
            skills: detail().skills,
            tools: (detail().contracts?.tools ?? []).map((name) => ({ name })),
            mcpServers: detail().mcpServers,
            mcpServerDetails: detail().mcpServerDetails,
          })}
        </>
      }
      readme={detail().readme ? renderPluginReadme(detail().readme) : undefined}
    />
  );
}

function CatalogDetailLoading() {
  return (
    <section
      class="plugin-catalog-detail plugin-catalog-detail--loading"
      aria-label={t("pluginsPage.detailLoading")}
    >
      <div class="plugin-catalog-detail__back skeleton" />
      <PluginDetailLoadingHero />
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
  );
}

export function renderPluginCatalogDetail(props: PluginCatalogDetailProps): JSX.Element {
  const source = createMemo(() => props.read);
  const receipt = createMemo(() => source().receipt());
  const resultId = createMemo(() => props.result?.plugin.id);
  const read = () => source().value();
  return (
    <SettingsPage {...{ wide: true, carapace: true }}>
      <Loading on={resultId() ?? receipt()} fallback={<CatalogDetailLoading />}>
        <Errored
          fallback={(error, reset) => (
            <div class="callout danger oc-banner oc-banner-error" role="alert">
              <span>{formatUiExternalText(formatUiError(error()))}</span>
              <button
                type="button"
                class="btn btn--sm"
                onClick={() => {
                  props.onRetry();
                  reset();
                }}
              >
                {t("pluginsPage.tryAgain")}
              </button>
            </div>
          )}
        >
          {read()}
          {!props.connected ? (
            <p class="plugin-catalog-detail__empty">{t("pluginsPage.discoveryOffline")}</p>
          ) : (
            <Show when={props.result} fallback={<CatalogDetailLoading />}>
              {(result) => <CatalogDetailContent value={result()} state={props} />}
            </Show>
          )}
        </Errored>
      </Loading>
    </SettingsPage>
  );
}
