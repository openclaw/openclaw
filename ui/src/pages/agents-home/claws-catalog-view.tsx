import type { JSX } from "@solidjs/web";
import { Errored, For, Loading, Show } from "solid-js";
import { pathForRoute } from "../../app-route-paths.ts";
import "../../components/modal-dialog.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsPage } from "../../components/solid/settings-ui.tsx";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import "../../styles/plugins.css";
import "../../styles/claws-catalog.css";
import { PluginDetailLoadingHero } from "../plugins/detail-loading-hero.tsx";
import type { ClawsCatalogViewProps } from "./claws-catalog-view-props.ts";
import { ClawsDetailView } from "./claws-detail-view.tsx";

function CatalogLoading(props: { pageMode: boolean }) {
  return (
    <Show
      when={props.pageMode}
      fallback={
        <>
          <p role="status">{t("clawsCatalog.loading")}</p>
          <ul class="claws-catalog__list" />
        </>
      }
    >
      <PluginDetailLoadingHero />
      <div class="plugin-catalog-detail__content">
        <div class="plugin-catalog-detail__main" aria-hidden="true">
          <div class="plugin-catalog-detail__loading-card skeleton" />
          <div class="plugin-catalog-detail__loading-card skeleton" />
        </div>
      </div>
    </Show>
  );
}

function CatalogRead(props: ClawsCatalogViewProps & { children: JSX.Element }) {
  return (
    <For each={[props.catalogRequest]}>
      {() => (
        <Errored
          fallback={(error) => (
            <>
              <div class="callout danger" role="alert">
                {formatUiError(error(), t("clawsCatalog.unavailable"))}
                <button class="btn btn--sm" onClick={() => props.onRetryCatalog()}>
                  {t("clawsCatalog.retry")}
                </button>
              </div>
              <Show when={!props.pageMode}>
                <ul class="claws-catalog__list" />
              </Show>
            </>
          )}
        >
          <Loading fallback={<CatalogLoading pageMode={props.pageMode} />}>
            {props.children}
          </Loading>
        </Errored>
      )}
    </For>
  );
}

function CatalogList(
  props: ClawsCatalogViewProps & { onSearchRef: (element: HTMLInputElement) => void },
) {
  return (
    <>
      <label class="claws-catalog__search">
        <span class="claws-catalog__search-icon" aria-hidden="true">
          <Icon name="search" />
        </span>
        <input
          ref={props.onSearchRef}
          type="search"
          data-claws-search
          autofocus
          aria-label={t("clawsCatalog.search")}
          placeholder={t("clawsCatalog.searchPlaceholder")}
          value={props.query}
          onInput={(event) => props.onSearch(event.currentTarget.value)}
        />
      </label>
      <CatalogRead {...props}>
        <Show when={props.readEntries().length === 0}>
          <p class="claws-catalog__empty">{t("clawsCatalog.empty")}</p>
        </Show>
        <ul class="claws-catalog__list">
          <For each={props.readEntries()} keyed={(entry) => entry.packageName}>
            {(entry) => (
              <li data-claws-entry>
                <div class="claws-catalog__entry-copy">
                  <h3>{entry().displayName}</h3>
                  <Show when={entry().summary}>
                    <p>{entry().summary}</p>
                  </Show>
                  <span class="claws-catalog__meta">{`@${entry().ownerHandle}`}</span>
                </div>
                <button
                  type="button"
                  class="btn btn--sm"
                  aria-label={t("clawsCatalog.addNamed", { name: entry().displayName })}
                  disabled={!entry().latestVersion}
                  onClick={() => props.onSelect(entry())}
                >
                  {t("clawsCatalog.add")}
                </button>
              </li>
            )}
          </For>
        </ul>
      </CatalogRead>
    </>
  );
}

export function ClawsCatalogView(props: ClawsCatalogViewProps) {
  let searchInput!: HTMLInputElement;
  return (
    <Show
      when={props.selected}
      fallback={
        props.pageMode ? (
          <SettingsPage wide>
            <section
              class="plugin-catalog-detail plugin-catalog-detail--loading"
              aria-label={t("clawsCatalog.title")}
            >
              <a
                class="plugin-catalog-detail__back"
                href={pathForRoute("claws", props.basePath)}
                onClick={(event) => {
                  if (shouldHandleNavigationClick(event)) {
                    event.preventDefault();
                    props.onBack();
                  }
                }}
              >
                {t("clawsCatalog.back")}
              </a>
              <CatalogRead {...props}>
                <Show when={props.readEntries().length > 0}>
                  <CatalogLoading pageMode />
                </Show>
              </CatalogRead>
            </section>
          </SettingsPage>
        ) : (
          <openclaw-modal-dialog
            prop:initialFocus={() => searchInput}
            label={t("clawsCatalog.title")}
            style={{ "--openclaw-modal-width": "min(720px, calc(100vw - 24px))" }}
            onModal-cancel={(event: Event) => {
              if (props.applying) {
                event.preventDefault();
              } else {
                props.onClose();
              }
            }}
          >
            <section class="claws-catalog oc-card" aria-label={t("clawsCatalog.title")}>
              <header class="claws-catalog__header">
                <h2>{t("clawsCatalog.title")}</h2>
                <button
                  type="button"
                  class="claws-catalog__close"
                  aria-label={t("clawsCatalog.close")}
                  title={t("clawsCatalog.close")}
                  disabled={props.applying}
                  onClick={() => props.onClose()}
                >
                  <Icon name="x" />
                </button>
              </header>
              <div class="claws-catalog__body">
                <CatalogList
                  {...props}
                  onSearchRef={(element) => {
                    searchInput = element;
                  }}
                />
              </div>
            </section>
          </openclaw-modal-dialog>
        )
      }
    >
      <ClawsDetailView view={props} />
    </Show>
  );
}
