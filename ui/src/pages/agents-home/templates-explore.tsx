import { createSignal, createStore, For, onSettled, Repeat, Show } from "solid-js";
import {
  CatalogDiscoveryChip,
  CatalogDiscoveryChips,
  CatalogDiscoverySearch,
  CatalogDiscoverySection,
} from "../../components/solid/catalog-discovery.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { SettingsPage } from "../../components/solid/settings-ui.tsx";
import { TemplateCategoryIcon } from "../../components/solid/template-category-icon.tsx";
import { registerTemplatesEnglish } from "../../i18n/locales/en-templates.ts";
import { CATALOG_INITIAL_PAGE_SIZE, CATALOG_NEXT_PAGE_SIZE } from "../../lib/catalog-page-size.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { createPageRequest, createPageRequestDelay } from "../../lib/page-request.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { templateCategories } from "../../lib/template-categories.ts";
import { renderPluginOfficialBadge } from "../plugins/plugin-card.tsx";
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

const SECTION_SIZE = 4;
const OVERVIEW_FRESH_MS = 30_000;
// Enough placeholders and decoded artwork to cover a tall first screen.
const SKELETON_SECTIONS = 6;
const FIRST_SCREEN_SIZE = 24;
type TemplateCategory = (typeof templateCategories)[number];
type TemplateSection = {
  category: TemplateCategory;
  entries: TemplateCatalogEntry[];
  additionalEntries?: TemplateCatalogEntry[];
};
type TemplateCatalog = {
  entries: TemplateCatalogEntry[];
  nextCursor?: string;
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
    <article
      class="plugin-catalog-card plugin-catalog-row agents-home__template-card"
      data-templates-entry
    >
      <button
        type="button"
        class="plugin-catalog-card__primary-link agents-home__template-card-link"
        aria-label={`${t("templatesCatalog.review")} ${props.entry.displayName}`}
        disabled={!props.entry.latestVersion}
        onClick={() => props.onSelect?.(props.entry)}
      />
      <div class="plugin-catalog-card__content">
        <div class="plugin-catalog-row__main">
          <span
            class="installed-plugins-card__art plugin-catalog-card__art template-art agents-home__template-art"
            aria-hidden="true"
          >
            <TemplateArtwork src={props.entry.iconUrl} packageName={props.entry.packageName} />
          </span>
          <div class="plugin-catalog-row__text">
            <div class="plugin-card-title-row agents-home__template-identity">
              <div class="agents-home__template-name">
                <h3>{props.entry.displayName}</h3>
                {props.entry.official ? renderPluginOfficialBadge() : undefined}
              </div>
              <span class="plugin-card-author">{`@${props.entry.ownerHandle}`}</span>
            </div>
            {/* Reserve the line even when a Template has no summary. */}
            <p class="installed-plugins-card__summary">{props.entry.summary}</p>
          </div>
          <div class="plugin-catalog-card__action">
            <button
              type="button"
              class="btn btn--sm plugin-catalog-card__install agents-home__template-add oc-action oc-action-secondary"
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
        </div>
        <Show when={props.addFailure?.entry.packageName === props.entry.packageName}>
          <p class="agents-home__template-error" role="alert">
            {props.addFailure?.message}
          </p>
        </Show>
      </div>
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
              <Repeat count={props.overview ? SECTION_SIZE : CATALOG_INITIAL_PAGE_SIZE}>
                {() => (
                  <div
                    class="plugin-catalog-card plugin-catalog-row agents-home__template-card"
                    data-templates-placeholder
                  >
                    <div class="plugin-catalog-card__content">
                      <div class="plugin-catalog-row__main">
                        <span class="installed-plugins-card__art plugin-catalog-card__art template-art agents-home__template-art" />
                        <div class="plugin-catalog-row__text">
                          <div class="plugin-card-title-row agents-home__template-identity">
                            <h3 style={{ width: "45%", ...placeholderBar("100%") }}>{"\u00a0"}</h3>
                          </div>
                          <p class="installed-plugins-card__summary" style={placeholderBar("90%")}>
                            {"\u00a0"}
                          </p>
                        </div>
                      </div>
                    </div>
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
    expandedEntries?: TemplateCatalogEntry[];
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

  function loadCatalog(
    category = view.category,
    query = view.query,
    options: { delay?: number; expandedEntries?: TemplateCatalogEntry[] } = {},
  ) {
    cancelSearch();
    const scope = gateway.capture();
    if (!scope || !canSearch()) {
      return;
    }
    loadedForConnection = true;
    const { ready, isCancelled, cancel } = createPageRequestDelay(options.delay ?? 0);
    cancelSearch = cancel;
    setRequest({
      scope,
      query,
      category,
      expandedEntries: options.expandedEntries,
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
    const category = view.category === "featured" ? "" : view.category;
    if (category !== view.category) {
      setView((draft) => {
        draft.category = category;
      });
    }
    loadCatalog(category, query, { delay: 150 });
  }

  function selectCategory(category: string, expandedEntries?: TemplateCatalogEntry[]) {
    if (category === view.category) {
      return;
    }
    setView((draft) => {
      draft.category = category;
    });
    loadCatalog(category, view.query, { expandedEntries });
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
            class="agents-home__explore plugin-catalog-results plugin-catalog-results--rows"
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
                    icon={<TemplateCategoryIcon icon={icon} />}
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
                  // Count read and artwork time too; a delayed response does not renew the shelf.
                  const startedAt = Date.now();
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
                            const section = catalog.sections.find(
                              (candidate) => candidate.category === category[0],
                            );
                            return section?.entries.length ? [{ ...section, category }] : [];
                          }),
                        };
                      }
                    }
                    if (!overview) {
                      const page = await searchTemplates(
                        current.scope.client,
                        current.query,
                        CATALOG_INITIAL_PAGE_SIZE,
                        {
                          category:
                            current.category && current.category !== "featured"
                              ? current.category
                              : undefined,
                          featured: current.category === "featured" || undefined,
                          paged: !current.query.trim() || undefined,
                        },
                      );
                      return { ...page, featured: [], sections: [] };
                    }
                    const [featured, sections] = await Promise.all([
                      searchTemplates(current.scope.client, "", SECTION_SIZE, { featured: true }),
                      Promise.all(
                        templateCategories
                          .slice(1)
                          .map(async (category): Promise<TemplateSection> => ({
                            category,
                            entries: (
                              await searchTemplates(current.scope.client, "", SECTION_SIZE, {
                                category: category[0],
                              })
                            ).entries,
                          })),
                      ),
                    ]);
                    return {
                      entries: [],
                      featured: featured.entries,
                      sections: sections.filter((section) => section.entries.length > 0),
                    };
                  };
                  const [result, setResult] = createSignal<TemplateCatalog | undefined>(
                    current.expandedEntries
                      ? {
                          entries: current.expandedEntries.slice(0, CATALOG_INITIAL_PAGE_SIZE),
                          featured: [],
                          sections: [],
                        }
                      : undefined,
                  );
                  const [initialError, setInitialError] = createSignal<string>();
                  onSettled(() => {
                    if (current.expandedEntries) {
                      return;
                    }
                    void readCatalog()
                      .then(async (catalog) => {
                        if (!current.category || current.query.trim()) {
                          await preloadTemplateArtwork(firstScreenArtwork(catalog));
                        }
                        if (current.isCurrent()) {
                          setResult(catalog);
                        }
                      })
                      .catch((error: unknown) => {
                        if (current.isCurrent()) {
                          setInitialError(formatUiError(error, t("templatesCatalog.unavailable")));
                        }
                      });
                  });
                  const [more, setMore] = createSignal<{
                    entries: TemplateCatalogEntry[];
                    nextCursor?: string;
                  }>();
                  const [visibleCount, setVisibleCount] = createSignal(CATALOG_INITIAL_PAGE_SIZE);
                  const [loadingMore, setLoadingMore] = createSignal(false);
                  const [loadError, setLoadError] = createSignal<string>();
                  const nextCursor = () => (more() ? more()?.nextCursor : result()?.nextCursor);
                  const entries = () =>
                    current.expandedEntries
                      ? current.expandedEntries.slice(0, visibleCount())
                      : [
                          ...new Map(
                            [...(result()?.entries ?? []), ...(more()?.entries ?? [])].map(
                              (entry) => [entry.packageName, entry],
                            ),
                          ).values(),
                        ];
                  const continuation = createPageRequest(() => {}, {
                    task: (cursor: string, { signal }) =>
                      searchTemplates(
                        current.scope.client,
                        "",
                        CATALOG_NEXT_PAGE_SIZE,
                        {
                          category:
                            current.category !== "featured"
                              ? current.category || undefined
                              : undefined,
                          featured: current.category === "featured" || undefined,
                          paged: true,
                          cursor,
                        },
                        signal,
                      ),
                    onComplete: (page) => {
                      if (current.isCurrent()) {
                        setMore((previous) => ({
                          ...page,
                          entries: [...(previous?.entries ?? []), ...page.entries],
                        }));
                        setLoadingMore(false);
                      }
                    },
                    onError: (error) => {
                      if (current.isCurrent()) {
                        setLoadError(formatUiError(error, t("templatesCatalog.unavailable")));
                        setLoadingMore(false);
                      }
                    },
                  });
                  onSettled(() => () => continuation.reset());
                  function loadMore() {
                    if (current.expandedEntries) {
                      setVisibleCount((count) => count + CATALOG_NEXT_PAGE_SIZE);
                      return;
                    }
                    const cursor = nextCursor();
                    if (cursor && !continuation.pending) {
                      setLoadingMore(true);
                      setLoadError(undefined);
                      void continuation.run(cursor);
                    }
                  }
                  return (
                    <Show
                      when={!initialError()}
                      fallback={
                        <InlineAlert tone="danger" role="alert">
                          {initialError()}
                          <button type="button" class="btn btn--sm" onClick={() => loadCatalog()}>
                            {t("templatesCatalog.retry")}
                          </button>
                        </InlineAlert>
                      }
                    >
                      <Show
                        when={result()}
                        fallback={<TemplateCatalogSkeleton overview={overview} />}
                      >
                        {(result) => (
                          <>
                            <Show
                              when={
                                gateway.connected &&
                                !unavailable() &&
                                entries().length === 0 &&
                                !nextCursor() &&
                                result().featured.length === 0 &&
                                result().sections.length === 0
                              }
                            >
                              <p class="muted agents-home__template-empty">
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
                                viewAllLabel={t("templatesCatalog.viewAll")}
                                onViewAll={() => selectCategory("featured")}
                              >
                                <div class="plugin-catalog-grid" data-templates-featured>
                                  <For
                                    each={result().featured}
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
                            </Show>
                            <Show when={overview}>
                              <For
                                each={result().sections}
                                keyed={(section) => section.category[0]}
                              >
                                {(section) => (
                                  <CatalogDiscoverySection
                                    id={section().category[0]}
                                    title={t(section().category[1])}
                                    onViewAll={() => {
                                      const { category, entries, additionalEntries } = section();
                                      const age = Date.now() - startedAt;
                                      const canExpand =
                                        additionalEntries &&
                                        current.isCurrent() &&
                                        age >= 0 &&
                                        age < OVERVIEW_FRESH_MS;
                                      selectCategory(
                                        category[0],
                                        canExpand ? [...entries, ...additionalEntries] : undefined,
                                      );
                                    }}
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
                            <Show when={!overview && (entries().length > 0 || nextCursor())}>
                              <CatalogDiscoverySection
                                id={current.category || "results"}
                                title={
                                  current.category === "featured"
                                    ? t("templatesCatalog.featured")
                                    : current.category
                                      ? t(
                                          templateCategories.find(
                                            ([slug]) => slug === current.category,
                                          )?.[1] ?? "templatesCatalog.categoryOther",
                                        )
                                      : t("templatesCatalog.results")
                                }
                              >
                                <div class="plugin-catalog-grid" data-templates-results>
                                  <For each={entries()} keyed={(entry) => entry.packageName}>
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
                                <Show when={loadError()}>
                                  {(error) => (
                                    <InlineAlert tone="danger" role="alert">
                                      {error()}
                                    </InlineAlert>
                                  )}
                                </Show>
                                <Show
                                  when={
                                    current.expandedEntries
                                      ? visibleCount() < current.expandedEntries.length
                                      : nextCursor()
                                  }
                                >
                                  <div class="plugin-catalog-load-more">
                                    <button
                                      type="button"
                                      class="btn btn--sm oc-action oc-action-secondary"
                                      disabled={loadingMore()}
                                      onClick={loadMore}
                                    >
                                      {t(
                                        loadingMore()
                                          ? "templatesCatalog.loadingMore"
                                          : "templatesCatalog.loadMore",
                                      )}
                                    </button>
                                  </div>
                                </Show>
                              </CatalogDiscoverySection>
                            </Show>
                          </>
                        )}
                      </Show>
                    </Show>
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
