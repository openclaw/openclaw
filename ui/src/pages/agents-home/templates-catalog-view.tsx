import type { JSX } from "@solidjs/web";
import { Errored, For, Loading, Show } from "solid-js";
import { pathForRoute } from "../../app-route-paths.ts";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { SettingsPage } from "../../components/solid/settings-ui.tsx";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import "../../styles/carapace-control-ui.css";
import "../../styles/plugins.css";
import "../../styles/templates-catalog.css";
import { handleNavigationClick } from "../../lib/navigation-click.ts";
import { PluginDetailLoadingHero } from "../plugins/detail-loading-hero.tsx";
import { TemplatePreviewView } from "./template-preview-view.tsx";
import type { TemplatesCatalogViewProps } from "./templates-catalog-view-props.ts";
import { TemplatesDetailView } from "./templates-detail-view.tsx";

function CatalogLoading() {
  return (
    <>
      <PluginDetailLoadingHero />
      <div class="plugin-catalog-detail__content">
        <div class="plugin-catalog-detail__main" aria-hidden="true">
          <div class="plugin-catalog-detail__loading-card skeleton" />
          <div class="plugin-catalog-detail__loading-card skeleton" />
        </div>
      </div>
    </>
  );
}

function DetailRead(props: TemplatesCatalogViewProps & { children: JSX.Element }) {
  return (
    <For each={[props.detailRequest]}>
      {() => (
        <Errored
          fallback={(error) => (
            <InlineAlert tone="danger" role="alert">
              {formatUiError(error(), t("templatesCatalog.unavailable"))}
              <button class="btn btn--sm" onClick={() => props.onRetryDetail()}>
                {t("templatesCatalog.retry")}
              </button>
            </InlineAlert>
          )}
        >
          <Loading fallback={<CatalogLoading />}>{props.children}</Loading>
        </Errored>
      )}
    </For>
  );
}

export function TemplatesCatalogView(props: TemplatesCatalogViewProps) {
  return (
    <Show when={!props.modal} fallback={<TemplatePreviewView view={props} />}>
      <Show
        when={props.selected}
        fallback={
          <SettingsPage wide>
            <section
              class="plugin-catalog-detail plugin-catalog-detail--loading"
              aria-label={t("templatesCatalog.title")}
            >
              <a
                class="plugin-catalog-detail__back"
                href={pathForRoute("templates", props.basePath)}
                onClick={(event) => handleNavigationClick(event, () => props.onBack())}
              >
                {t("templatesCatalog.back")}
              </a>
              <DetailRead {...props}>
                <Show when={props.readDetail()}>
                  <CatalogLoading />
                </Show>
              </DetailRead>
            </section>
          </SettingsPage>
        }
      >
        <TemplatesDetailView view={props} />
      </Show>
    </Show>
  );
}
