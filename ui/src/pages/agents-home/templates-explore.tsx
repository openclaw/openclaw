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
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { createPageRequestDelay } from "../../lib/page-request.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { templateCategories } from "../../lib/template-categories.ts";
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
const SKELETON_SECTIONS = 4;
const FIRST_SCREEN_SIZE = 24;
type TemplateCategory = (typeof templateCategories)[number];
type TemplateSection = {
  category: TemplateCategory;
  entries: TemplateCatalogEntry[];
  additionalEntries?: TemplateCatalogEntry[];
};
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
        class="plugin-catalog-card__primary-link agents-home__template-card-link"
        aria-label={`${t("templatesCatalog.review")} ${props.entry.displayName}`}
        disabled={!props.entry.latestVersion}
        onClick={() => props.onSelect?.(props.entry)}
      />
      <header class="installed-plugins-card__head agents-home__template-head">
        <span class="template-art agents-home__template-art" aria-hidden="true">
          <TemplateArtwork src={props.entry.iconUrl} />
        </span>
        <div class="plugin-catalog-card__content">
          <div class="plugin-card-title-row agents-home__template-identity">
            <h3>{props.entry.displayName}</h3>
            <span class="plugin-card-author">{`@${props.entry.ownerHandle}`}</span>
          </div>
          {/* Reserve both lines even when a Template has no summary. */}
          <p class="installed-plugins-card__summary">{props.entry.summary}</p>
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
      </header>
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
                    <header class="installed-plugins-card__head agents-home__template-head">
                      <span class="template-art agents-home__template-art" />
                      <div class="plugin-catalog-card__content">
                        <div class="plugin-card-title-row agents-home__template-identity">
                          <h3 style={placeholderBar("70%")}>{"\u00a0"}</h3>
                          <span class="plugin-card-author" style={placeholderBar("40%")}>
                            {"\u00a0"}
                          </span>
                        </div>
                        <p class="installed-plugins-card__summary">
                          <span style={{ display: "block", ...placeholderBar("100%") }}>
                            {"\u00a0"}
                          </span>
                          <span style={{ display: "block", ...placeholderBar("60%") }}>
                            {"\u00a0"}
                          </span>
                        </p>
                      </div>
                    </header>
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
    loadCatalog(view.category, query, { delay: 150 });
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
                  const result = createMemo<TemplateCatalog>(() => {
                    if (current.expandedEntries) {
                      return { entries: current.expandedEntries, featured: [], sections: [] };
                    }
                    return readCatalog().then(async (catalog) => {
                      // Category cards reserve their icon space. Reveal the complete list as soon
                      // as it arrives; the browser loads the visible icons rather than blocking
                      // every card on a second batch of up to 24 artwork decodes.
                      if (!current.category || current.query.trim()) {
                        await preloadTemplateArtwork(firstScreenArtwork(catalog));
                      }
                      return catalog;
                    });
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
