import type { JSX } from "@solidjs/web";
import { Errored, For, Loading, Show } from "solid-js";
import { pathForRoute } from "../../app-route-paths.ts";
import { SettingsPage } from "../../components/solid/settings-ui.tsx";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { handleNavigationClick } from "../../lib/navigation-click.ts";
import "../../styles/plugins.css";
import "../../styles/claws-catalog.css";
import { PluginDetailLoadingHero } from "../plugins/detail-loading-hero.tsx";
import type { ClawsCatalogViewProps } from "./claws-catalog-view-props.ts";
import { ClawsDetailView } from "./claws-detail-view.tsx";

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

function CatalogRead(props: ClawsCatalogViewProps & { children: JSX.Element }) {
  return (
    <For each={[props.catalogRequest]}>
      {() => (
        <Errored
          fallback={(error) => (
            <div class="callout danger" role="alert">
              {formatUiError(error(), t("clawsCatalog.unavailable"))}
              <button class="btn btn--sm" onClick={() => props.onRetryCatalog()}>
                {t("clawsCatalog.retry")}
              </button>
            </div>
          )}
        >
          <Loading fallback={<CatalogLoading />}>{props.children}</Loading>
        </Errored>
      )}
    </For>
  );
}

export function ClawsCatalogView(props: ClawsCatalogViewProps) {
  return (
    <Show
      when={props.selected}
      fallback={
        <SettingsPage wide>
          <section
            class="plugin-catalog-detail plugin-catalog-detail--loading"
            aria-label={t("clawsCatalog.title")}
          >
            <a
              class="plugin-catalog-detail__back"
              href={pathForRoute("claws", props.basePath)}
              onClick={(event) => handleNavigationClick(event, () => props.onBack())}
            >
              {t("clawsCatalog.back")}
            </a>
            <CatalogRead {...props}>
              <Show when={props.readEntries().length > 0}>
                <CatalogLoading />
              </Show>
            </CatalogRead>
          </section>
        </SettingsPage>
      }
    >
      <ClawsDetailView view={props} />
    </Show>
  );
}
