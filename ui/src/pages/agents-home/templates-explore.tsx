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
import { Icon } from "../../components/solid/icon.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { SettingsPage } from "../../components/solid/settings-ui.tsx";
import { registerTemplatesEnglish } from "../../i18n/locales/en-templates.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { createPageRequestDelay } from "../../lib/page-request.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { PluginsHubHeader } from "../plugins/plugins-hub-header.tsx";
import { pluginsHubPanel } from "../plugins/plugins-hub.ts";
import { preloadTemplateArtwork, TemplateArtwork } from "./template-artwork.tsx";
import { TemplateUpload } from "./template-upload.tsx";
import "../../styles/templates-catalog.css";
import "../../styles/carapace-control-ui.css";
import "../../styles/plugins.css";
import {
  readTemplatesOverview,
  searchTemplates,
  type TemplateCatalogEntry,
} from "./templates-catalog-client.ts";

registerEnglishCatalog(registerTemplatesEnglish);

// ClawHub's current Template taxonomy. The "other" bucket is assigned by ClawHub.
const templateCategories = [
  ["", "templatesCatalog.categoryAll", "layoutGrid"],
  ["personal", "templatesCatalog.categoryPersonal", "users"],
  ["health", "templatesCatalog.categoryHealth", "activity"],
  ["travel", "templatesCatalog.categoryTravel", "globe"],
  ["productivity", "templatesCatalog.categoryProductivity", "listChecks"],
  ["research", "templatesCatalog.categoryResearch", "search"],
  ["engineering", "templatesCatalog.categoryEngineering", "braces"],
  ["governance", "templatesCatalog.categoryGovernance", "shield"],
  ["operations", "templatesCatalog.categoryOperations", "settings"],
  ["finance", "templatesCatalog.categoryFinance", "coins"],
  ["sales", "templatesCatalog.categorySales", "barChart"],
  ["product", "templatesCatalog.categoryProduct", "box"],
  ["people", "templatesCatalog.categoryPeople", "users"],
  ["other", "templatesCatalog.categoryOther", "layers"],
] as const satisfies readonly (readonly [string, string, IconName])[];
const SECTION_SIZE = 8;
// Enough placeholders and decoded artwork to cover a tall first screen.
const SKELETON_SECTIONS = 4;
const FIRST_SCREEN_SIZE = 24;
type TemplateCategory = (typeof templateCategories)[number];
type TemplateSection = { category: TemplateCategory; entries: TemplateCatalogEntry[] };
type TemplateCatalog = {
  entries: TemplateCatalogEntry[];
  featured: TemplateCatalogEntry[];
  sections: TemplateSection[];
};

function firstScreenArtwork(catalog: TemplateCatalog): string[] {
  const entries = [
    ...catalog.featured,
    ...catalog.sections.flatMap((section) => section.entries),
    ...catalog.entries,
  ];
  const urls = new Set(entries.flatMap((entry) => (entry.iconUrl ? [entry.iconUrl] : [])));
  return [...urls].slice(0, FIRST_SCREEN_SIZE);
}

type TemplateAddProps = {
  onAdd: (entry: TemplateCatalogEntry) => void;
  addingPackageName: string | null;
  addDisabled: boolean;
  /** The last Add that left nothing behind, shown on that Template's card. */
  addFailure?: { entry: Pick<TemplateCatalogEntry, "packageName">; message: string } | null;
};

function TemplateCard(
  props: TemplateAddProps & {
    entry: TemplateCatalogEntry;
    onSelect?: (entry: TemplateCatalogEntry) => void;
  },
) {
  return (
    <article class="agents-home__template-card oc-card" data-templates-entry>
      <button
        type="button"
        class="agents-home__template-card-link"
        aria-label={`${t("templatesCatalog.review")} ${props.entry.displayName}`}
        disabled={!props.entry.latestVersion}
        onClick={() => props.onSelect?.(props.entry)}
      />
      <div class="agents-home__template-head">
        <span class="agents-home__template-art" aria-hidden="true">
          <TemplateArtwork src={props.entry.iconUrl} />
        </span>
        <div class="agents-home__template-identity">
          <h3>{props.entry.displayName}</h3>
          <span>{`@${props.entry.ownerHandle}`}</span>
        </div>
        <button
          type="button"
          class="btn btn--sm agents-home__template-add oc-action oc-action-secondary"
          aria-label={t("templatesCatalog.addNamed", { name: props.entry.displayName })}
          disabled={!props.entry.latestVersion || props.addDisabled}
          aria-busy={props.addingPackageName === props.entry.packageName ? "true" : undefined}
          onClick={(event) => {
            event.stopPropagation();
            props.onAdd(props.entry);
          }}
        >
          <Show when={props.addingPackageName === props.entry.packageName}>
            <span class="btn__spinner" aria-hidden="true" />
          </Show>
          {t(
            props.addingPackageName === props.entry.packageName
              ? "templatesCatalog.adding"
              : "templatesCatalog.add",
          )}
        </button>
      </div>
      {/* Always present: a Template without a summary keeps the reserved lines. */}
      <p class="agents-home__template-summary">{props.entry.summary}</p>
      <Show when={props.addFailure?.entry.packageName === props.entry.packageName}>
        <p class="agents-home__template-error" role="alert">
          {props.addFailure?.message}
        </p>
      </Show>
    </article>
  );
}

// Placeholder bars are drawn inline: the Control UI stylesheet is at its size ceiling.
const placeholderBar = (width: string) => ({
  background: `linear-gradient(var(--bg-accent), var(--bg-accent)) 0 / ${width} 12px no-repeat`,
});

/** Mirrors the loaded sections and cards so content arrives in place. */
function TemplateCatalogSkeleton(props: { overview: boolean }) {
  return (
    <div
      class="plugin-catalog-results__body"
      role="status"
      aria-label={t("templatesCatalog.loading")}
    >
      <Repeat count={props.overview ? SKELETON_SECTIONS : 1}>
        {() => (
          <section
            class={[
              "plugin-catalog-section",
              { "plugin-catalog-section--expandable": props.overview },
            ]}
            aria-hidden="true"
          >
            <header class="plugin-catalog-section__header">
              <h2 style={{ width: "120px", ...placeholderBar("100%") }}>{"\u00a0"}</h2>
            </header>
            <div class="plugin-catalog-grid">
              <Repeat count={props.overview ? SECTION_SIZE : FIRST_SCREEN_SIZE}>
                {() => (
                  <div class="agents-home__template-card oc-card" data-templates-placeholder>
                    <div class="agents-home__template-head">
                      <span class="agents-home__template-art" />
                      <div class="agents-home__template-identity">
                        <h3 style={placeholderBar("70%")}>{"\u00a0"}</h3>
                        <span style={placeholderBar("40%")}>{"\u00a0"}</span>
                      </div>
                    </div>
                    <p class="agents-home__template-summary">
                      <span style={{ display: "block", ...placeholderBar("100%") }}>
                        {"\u00a0"}
                      </span>
                      <span style={{ display: "block", ...placeholderBar("60%") }}>{"\u00a0"}</span>
                    </p>
                  </div>
                )}
              </Repeat>
            </div>
          </section>
        )}
      </Repeat>
    </div>
  );
}

export function TemplatesExplore(
  props: TemplateAddProps & {
    onSelect?: (entry: TemplateCatalogEntry) => void;
  },
) {
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
    canCallGatewayMethod(gateway.snapshot, "templates.catalog.search", "operator.read");
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
        canCallGatewayMethod(context.gateway.snapshot, "templates.catalog.search", "operator.read"),
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
    <openclaw-templates-explore>
      <PluginsHubHeader
        actions={<TemplateUpload />}
        active="templates"
        subtitle={t("templatesCatalog.exploreDescription")}
        wide
        class="templates-catalog-header"
        onSelect={(tab) => {
          if (tab !== "templates") {
            context.navigate(tab);
          }
        }}
      />
      <SettingsPage wide carapace>
        <div class="agents-home" {...pluginsHubPanel("templates")}>
          <section
            class="agents-home__explore plugin-catalog-results"
            data-templates-explore
            aria-label={t("tabs.templates")}
          >
            <CatalogDiscoverySearch>
              <input
                type="search"
                class="oc-input"
                data-templates-search
                aria-label={t("templatesCatalog.search")}
                placeholder={t("templatesCatalog.searchPlaceholder")}
                value={view.query}
                disabled={!gateway.connected || unavailable()}
                onInput={(event) => search(event.currentTarget.value)}
              />
            </CatalogDiscoverySearch>
            <CatalogDiscoveryChips label={t("templatesCatalog.categories")}>
              <For each={templateCategories}>
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
                <InlineAlert tone="warning" role="status">
                  {t("templatesCatalog.unavailable")}
                </InlineAlert>
              </Show>
              <Show when={request()} keyed>
                {(current) => {
                  const overview = !current.query.trim() && !current.category;
                  const readCatalog = async (): Promise<TemplateCatalog> => {
                    if (current.ready) {
                      await current.ready;
                    }
                    if (!current.isCurrent()) {
                      return { entries: [], featured: [], sections: [] };
                    }
                    if (overview) {
                      const catalog = await readTemplatesOverview(
                        current.scope.client,
                        SECTION_SIZE,
                      );
                      if (!current.isCurrent()) {
                        return { entries: [], featured: [], sections: [] };
                      }
                      if (catalog) {
                        return {
                          entries: [],
                          featured: catalog.featured,
                          sections: templateCategories.slice(1).flatMap((category) => {
                            const entries = catalog.sections.find(
                              (section) => section.category === category[0],
                            )?.entries;
                            return entries?.length ? [{ category, entries }] : [];
                          }),
                        };
                      }
                    }
                    const [entries, featured, sections] = await Promise.all([
                      overview
                        ? Promise.resolve([])
                        : searchTemplates(current.scope.client, current.query, undefined, {
                            category: current.category || undefined,
                          }),
                      overview
                        ? searchTemplates(current.scope.client, "", SECTION_SIZE, {
                            featured: true,
                          })
                        : Promise.resolve([]),
                      overview
                        ? Promise.all(
                            templateCategories
                              .slice(1)
                              .map(async (category): Promise<TemplateSection> => ({
                                category,
                                entries: await searchTemplates(
                                  current.scope.client,
                                  "",
                                  SECTION_SIZE,
                                  {
                                    category: category[0],
                                  },
                                ),
                              })),
                          )
                        : Promise.resolve([]),
                    ]);
                    return {
                      entries,
                      featured,
                      sections: sections.filter((section) => section.entries.length > 0),
                    };
                  };
                  const result = createMemo(async () => {
                    const catalog = await readCatalog();
                    await preloadTemplateArtwork(firstScreenArtwork(catalog));
                    return catalog;
                  });
                  return (
                    <Errored
                      fallback={(error) => (
                        <InlineAlert tone="danger" role="alert">
                          {formatUiError(error(), t("templatesCatalog.unavailable"))}
                          <button type="button" class="btn btn--sm" onClick={() => loadCatalog()}>
                            {t("templatesCatalog.retry")}
                          </button>
                        </InlineAlert>
                      )}
                    >
                      <Loading fallback={<TemplateCatalogSkeleton overview={overview} />}>
                        <Show
                          when={
                            gateway.connected &&
                            !unavailable() &&
                            result().entries.length === 0 &&
                            result().featured.length === 0 &&
                            result().sections.length === 0
                          }
                        >
                          <p class="agents-home__template-empty">
                            {t(
                              view.query.trim() || view.category
                                ? "templatesCatalog.empty"
                                : "templatesCatalog.emptyUnfiltered",
                            )}
                          </p>
                        </Show>
                        <Show when={overview && result().featured.length > 0}>
                          <CatalogDiscoverySection
                            id="featured"
                            title={t("templatesCatalog.featured")}
                          >
                            <div class="plugin-catalog-grid" data-templates-featured>
                              <For each={result().featured} keyed={(entry) => entry.packageName}>
                                {(entry) => (
                                  <TemplateCard
                                    entry={entry()}
                                    onSelect={props.onSelect}
                                    onAdd={props.onAdd}
                                    addingPackageName={props.addingPackageName}
                                    addDisabled={props.addDisabled}
                                    addFailure={props.addFailure}
                                  />
                                )}
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
                                viewAllLabel={t("templatesCatalog.viewAll")}
                              >
                                <div
                                  class="plugin-catalog-grid"
                                  data-templates-category={section().category[0]}
                                >
                                  <For
                                    each={section().entries}
                                    keyed={(entry) => entry.packageName}
                                  >
                                    {(entry) => (
                                      <TemplateCard
                                        entry={entry()}
                                        onSelect={props.onSelect}
                                        onAdd={props.onAdd}
                                        addingPackageName={props.addingPackageName}
                                        addDisabled={props.addDisabled}
                                        addFailure={props.addFailure}
                                      />
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
                                    templateCategories.find(
                                      ([slug]) => slug === current.category,
                                    )?.[1] ?? "templatesCatalog.categoryOther",
                                  )
                                : t("templatesCatalog.results")
                            }
                          >
                            <div class="plugin-catalog-grid" data-templates-results>
                              <For each={result().entries} keyed={(entry) => entry.packageName}>
                                {(entry) => (
                                  <TemplateCard
                                    entry={entry()}
                                    onSelect={props.onSelect}
                                    onAdd={props.onAdd}
                                    addingPackageName={props.addingPackageName}
                                    addDisabled={props.addDisabled}
                                    addFailure={props.addFailure}
                                  />
                                )}
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
    </openclaw-templates-explore>
  );
}
