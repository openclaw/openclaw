import {
  createMemo,
  createSignal,
  createStore,
  Errored,
  For,
  Loading,
  onSettled,
  Repeat,
  Show,
} from "solid-js";
import type { IconName } from "../../components/icon-data.ts";
import {
  CatalogDiscoveryChip,
  CatalogDiscoveryChips,
  CatalogDiscoverySearch,
  CatalogDiscoverySection,
} from "../../components/solid/catalog-discovery.tsx";
import { HubPageHeader } from "../../components/solid/hub-page-header.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsPage } from "../../components/solid/settings-ui.tsx";
import { registerClawsEnglish } from "../../i18n/locales/en-claws.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { createPageRequestDelay } from "../../lib/page-request.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { ClawArtwork } from "./claw-artwork.tsx";
import { searchClaws, type ClawCatalogEntry } from "./claws-catalog-client.ts";
import "../../styles/agents-home.css";
import "../../styles/carapace-control-ui.css";
import "../../styles/plugins.css";

registerEnglishCatalog(registerClawsEnglish);

// ClawHub's current Claw taxonomy. The "other" bucket is assigned by ClawHub.
const clawCategories = [
  ["", "clawsCatalog.categoryAll", "layoutGrid"],
  ["personal", "clawsCatalog.categoryPersonal", "users"],
  ["health", "clawsCatalog.categoryHealth", "activity"],
  ["travel", "clawsCatalog.categoryTravel", "globe"],
  ["productivity", "clawsCatalog.categoryProductivity", "listChecks"],
  ["research", "clawsCatalog.categoryResearch", "search"],
  ["engineering", "clawsCatalog.categoryEngineering", "braces"],
  ["governance", "clawsCatalog.categoryGovernance", "shield"],
  ["operations", "clawsCatalog.categoryOperations", "settings"],
  ["finance", "clawsCatalog.categoryFinance", "coins"],
  ["sales", "clawsCatalog.categorySales", "barChart"],
  ["product", "clawsCatalog.categoryProduct", "box"],
  ["people", "clawsCatalog.categoryPeople", "users"],
  ["other", "clawsCatalog.categoryOther", "layers"],
] as const satisfies readonly (readonly [string, string, IconName])[];
const SECTION_SIZE = 8;
type ClawCategory = (typeof clawCategories)[number];
type ClawSection = { category: ClawCategory; entries: ClawCatalogEntry[] };

function ClawCard(props: {
  entry: ClawCatalogEntry;
  onSelect?: (entry: ClawCatalogEntry) => void;
}) {
  return (
    <article class="agents-home__claw-card oc-card" data-claws-entry>
      <button
        type="button"
        class="agents-home__claw-card-link"
        aria-label={`${t("clawsCatalog.review")} ${props.entry.displayName}`}
        disabled={!props.entry.latestVersion}
        onClick={() => props.onSelect?.(props.entry)}
      />
      <div class="agents-home__claw-head">
        <span class="agents-home__claw-art" aria-hidden="true">
          <ClawArtwork src={props.entry.iconUrl} />
        </span>
        <div class="agents-home__claw-identity">
          <h3>{props.entry.displayName}</h3>
          <span>{`@${props.entry.ownerHandle}`}</span>
        </div>
        <button
          type="button"
          class="btn btn--sm agents-home__claw-add oc-action oc-action-secondary"
          aria-label={t("clawsCatalog.addNamed", { name: props.entry.displayName })}
          disabled={!props.entry.latestVersion}
          onClick={() => props.onSelect?.(props.entry)}
        >
          {t("clawsCatalog.add")}
        </button>
      </div>
      <Show when={props.entry.summary}>
        <p class="agents-home__claw-summary">{props.entry.summary}</p>
      </Show>
    </article>
  );
}

export function ClawsExplore(props: { onSelect?: (entry: ClawCatalogEntry) => void }) {
  const context = useApplication();
  const [view, setView] = createStore({ query: "", category: "" });
  const [request, setRequest] = createSignal<{
    scope: GatewayConnectionScope;
    query: string;
    category: string;
    ready?: Promise<void>;
    isCurrent: () => boolean;
  }>();
  let loadedForConnection = false;
  let cancelSearch = () => {};
  const canSearch = () =>
    canCallGatewayMethod(gateway.snapshot, "claws.catalog.search", "operator.read");
  const gateway = useGatewayPage({
    getGateway: () => context.gateway,
    onIdentityChange: () =>
      setView((draft) => {
        draft.query = "";
        draft.category = "";
      }),
    invalidateRequests: () => {
      cancelSearch();
      loadedForConnection = false;
      setRequest(undefined);
    },
    onSnapshot: ({ identityChanged }) => {
      if (gateway.connected && canSearch() && !loadedForConnection) {
        loadCatalog(identityChanged ? "" : view.category, identityChanged ? "" : view.query);
      }
    },
  });
  onSettled(() => () => cancelSearch());

  function loadCatalog(category = view.category, query = view.query, delay = 0) {
    cancelSearch();
    const scope = gateway.capture();
    if (!scope || !canSearch()) {
      return;
    }
    loadedForConnection = true;
    const { ready, isCancelled, cancel } = createPageRequestDelay(delay);
    cancelSearch = cancel;
    setRequest({
      scope,
      query,
      category,
      ready,
      isCurrent: () =>
        !isCancelled() &&
        gateway.isCurrent(scope) &&
        canCallGatewayMethod(context.gateway.snapshot, "claws.catalog.search", "operator.read"),
    });
  }

  function search(query: string) {
    setView((draft) => {
      draft.query = query;
    });
    loadCatalog(view.category, query, 150);
  }

  function selectCategory(category: string) {
    if (category === view.category) {
      return;
    }
    setView((draft) => {
      draft.category = category;
    });
    loadCatalog(category);
  }

  const unavailable = () => gateway.connected && !canSearch();
  return (
    <openclaw-claws-explore>
      <HubPageHeader
        active="claws"
        subtitle={t("clawsCatalog.exploreDescription")}
        wide
        class="claws-catalog-header"
      />
      <SettingsPage wide carapace>
        <div class="agents-home">
          <section
            class="agents-home__explore plugin-catalog-results"
            data-claws-explore
            aria-label={t("tabs.claws")}
          >
            <CatalogDiscoverySearch>
              <input
                type="search"
                class="oc-input"
                data-claws-search
                aria-label={t("clawsCatalog.search")}
                placeholder={t("clawsCatalog.searchPlaceholder")}
                value={view.query}
                disabled={!gateway.connected || unavailable()}
                onInput={(event) => search(event.currentTarget.value)}
              />
            </CatalogDiscoverySearch>
            <CatalogDiscoveryChips label={t("clawsCatalog.categories")}>
              <For each={clawCategories}>
                {([slug, label, icon]) => (
                  <CatalogDiscoveryChip
                    active={view.category === slug}
                    onClick={() => selectCategory(slug)}
                    icon={<Icon name={icon} />}
                  >
                    {t(label)}
                  </CatalogDiscoveryChip>
                )}
              </For>
            </CatalogDiscoveryChips>
            <div class="plugin-catalog-results__body">
              <Show when={unavailable()}>
                <div class="callout warn" role="status">
                  {t("clawsCatalog.unavailable")}
                </div>
              </Show>
              <Show when={request()} keyed>
                {(current) => {
                  const overview = !current.query.trim() && !current.category;
                  const result = createMemo(async () => {
                    if (current.ready) {
                      await current.ready;
                    }
                    if (!current.isCurrent()) {
                      const sections: ClawSection[] = [];
                      return { entries: [], featured: [], sections };
                    }
                    const [entries, featured, sections] = await Promise.all([
                      overview
                        ? Promise.resolve([])
                        : searchClaws(current.scope.client, current.query, undefined, {
                            category: current.category || undefined,
                          }),
                      overview
                        ? searchClaws(current.scope.client, "", SECTION_SIZE, { featured: true })
                        : Promise.resolve([]),
                      overview
                        ? Promise.all(
                            clawCategories.slice(1).map(async (category): Promise<ClawSection> => ({
                              category,
                              entries: await searchClaws(current.scope.client, "", SECTION_SIZE, {
                                category: category[0],
                              }),
                            })),
                          )
                        : Promise.resolve([]),
                    ]);
                    return {
                      entries,
                      featured,
                      sections: sections.filter((section) => section.entries.length > 0),
                    };
                  });
                  return (
                    <Errored
                      fallback={(error) => (
                        <div class="callout danger" role="alert">
                          {formatUiError(error(), t("clawsCatalog.unavailable"))}
                          <button type="button" class="btn btn--sm" onClick={() => loadCatalog()}>
                            {t("clawsCatalog.retry")}
                          </button>
                        </div>
                      )}
                    >
                      <Loading
                        fallback={
                          <div
                            class="plugin-catalog-grid"
                            role="status"
                            aria-label={t("clawsCatalog.loading")}
                          >
                            <Repeat count={4}>
                              {() => <div class="agents-home__claw-skeleton" aria-hidden="true" />}
                            </Repeat>
                          </div>
                        }
                      >
                        <Show
                          when={
                            gateway.connected &&
                            !unavailable() &&
                            result().entries.length === 0 &&
                            result().featured.length === 0 &&
                            result().sections.length === 0
                          }
                        >
                          <p class="agents-home__claw-empty">{t("clawsCatalog.empty")}</p>
                        </Show>
                        <Show when={overview && result().featured.length > 0}>
                          <CatalogDiscoverySection id="featured" title={t("clawsCatalog.featured")}>
                            <div class="plugin-catalog-grid" data-claws-featured>
                              <For each={result().featured} keyed={(entry) => entry.packageName}>
                                {(entry) => <ClawCard entry={entry()} onSelect={props.onSelect} />}
                              </For>
                            </div>
                          </CatalogDiscoverySection>
                        </Show>
                        <Show when={overview}>
                          <For each={result().sections} keyed={(section) => section.category[0]}>
                            {(section) => (
                              <CatalogDiscoverySection
                                id={section().category[0]}
                                title={t(section().category[1])}
                                onViewAll={() => selectCategory(section().category[0])}
                                viewAllLabel={t("clawsCatalog.viewAll")}
                              >
                                <div
                                  class="plugin-catalog-grid"
                                  data-claws-category={section().category[0]}
                                >
                                  <For
                                    each={section().entries}
                                    keyed={(entry) => entry.packageName}
                                  >
                                    {(entry) => (
                                      <ClawCard entry={entry()} onSelect={props.onSelect} />
                                    )}
                                  </For>
                                </div>
                              </CatalogDiscoverySection>
                            )}
                          </For>
                        </Show>
                        <Show when={!overview && result().entries.length > 0}>
                          <CatalogDiscoverySection
                            id={current.category || "results"}
                            title={
                              current.category
                                ? t(
                                    clawCategories.find(
                                      ([slug]) => slug === current.category,
                                    )?.[1] ?? "clawsCatalog.categoryOther",
                                  )
                                : t("clawsCatalog.results")
                            }
                          >
                            <div class="plugin-catalog-grid" data-claws-results>
                              <For each={result().entries} keyed={(entry) => entry.packageName}>
                                {(entry) => <ClawCard entry={entry()} onSelect={props.onSelect} />}
                              </For>
                            </div>
                          </CatalogDiscoverySection>
                        </Show>
                      </Loading>
                    </Errored>
                  );
                }}
              </Show>
            </div>
          </section>
        </div>
      </SettingsPage>
    </openclaw-claws-explore>
  );
}
