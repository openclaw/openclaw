import { createStore, For, onCleanup, Show } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { registerAgentsHomeEnglish } from "../../i18n/locales/en-agents-home.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { searchClaws, type ClawCatalogEntry } from "./claws-catalog-client.ts";
import "../../styles/agents-home.css";

registerEnglishCatalog(registerAgentsHomeEnglish);

// ClawHub's current Claw taxonomy. The "other" bucket is assigned by ClawHub.
const clawCategories = [
  ["", "clawsCatalog.categoryAll"],
  ["personal", "clawsCatalog.categoryPersonal"],
  ["health", "clawsCatalog.categoryHealth"],
  ["travel", "clawsCatalog.categoryTravel"],
  ["productivity", "clawsCatalog.categoryProductivity"],
  ["research", "clawsCatalog.categoryResearch"],
  ["engineering", "clawsCatalog.categoryEngineering"],
  ["governance", "clawsCatalog.categoryGovernance"],
  ["operations", "clawsCatalog.categoryOperations"],
  ["finance", "clawsCatalog.categoryFinance"],
  ["sales", "clawsCatalog.categorySales"],
  ["product", "clawsCatalog.categoryProduct"],
  ["people", "clawsCatalog.categoryPeople"],
  ["other", "clawsCatalog.categoryOther"],
] as const;

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
          <Icon name="box" />
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
  const [view, setView] = createStore<{
    entries: ClawCatalogEntry[];
    featured: ClawCatalogEntry[];
    query: string;
    category: string;
    loading: boolean;
    error: string | null;
  }>({
    entries: [],
    featured: [],
    query: "",
    category: "",
    loading: false,
    error: null,
  });
  const updateView = (patch: Partial<typeof view>) => {
    setView((state) => {
      Object.assign(state, patch);
    });
  };
  let searchRevision = 0;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let loadedForConnection = false;
  const clearSearchTimer = () => {
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
  };
  const canSearch = () =>
    canCallGatewayMethod(gateway.snapshot, "claws.catalog.search", "operator.read");
  const gateway = useGatewayPage({
    getGateway: () => context.gateway,
    onIdentityChange: () => updateView({ query: "", category: "" }),
    invalidateRequests: () => {
      searchRevision += 1;
      clearSearchTimer();
      loadedForConnection = false;
      updateView({ entries: [], featured: [], loading: false, error: null });
    },
    onSnapshot: () => {
      if (gateway.connected && canSearch() && !loadedForConnection) {
        void loadCatalog();
      }
    },
  });
  onCleanup(clearSearchTimer);

  async function loadCatalog(category = view.category, query = view.query) {
    const scope = gateway.capture();
    if (!scope || !canSearch()) {
      return;
    }
    const revision = ++searchRevision;
    loadedForConnection = true;
    updateView({ entries: [], featured: [], loading: true, error: null });
    try {
      const [entries, featured] = await Promise.all([
        searchClaws(scope.client, query, undefined, { category: category || undefined }),
        !query.trim() && !category
          ? searchClaws(scope.client, "", undefined, { featured: true })
          : Promise.resolve([]),
      ]);
      if (gateway.isCurrent(scope) && revision === searchRevision) {
        updateView({ entries, featured });
      }
    } catch (error) {
      if (gateway.isCurrent(scope) && revision === searchRevision) {
        updateView({ error: formatUiError(error, t("clawsCatalog.unavailable")) });
      }
    } finally {
      if (gateway.isCurrent(scope) && revision === searchRevision) {
        updateView({ loading: false });
      }
    }
  }

  function search(query: string) {
    searchRevision += 1;
    clearSearchTimer();
    updateView({ query, entries: [], featured: [], loading: true, error: null });
    searchTimer = setTimeout(() => {
      searchTimer = null;
      void loadCatalog(view.category, query);
    }, 150);
  }

  function selectCategory(category: string) {
    if (category === view.category) {
      return;
    }
    searchRevision += 1;
    clearSearchTimer();
    updateView({ category, entries: [], featured: [], loading: true, error: null });
    void loadCatalog(category);
  }

  const unavailable = () => gateway.connected && !canSearch();
  const browseEntries = () => {
    const featuredNames = new Set(view.featured.map((entry) => entry.packageName));
    return view.entries.filter((entry) => !featuredNames.has(entry.packageName));
  };
  return (
    <openclaw-claws-explore>
      <section
        class="agents-home__explore"
        data-claws-explore
        aria-label={t("clawsCatalog.explore")}
      >
        <div class="agents-home__explore-toolbar">
          <div class="agents-home__explore-heading">
            <h2>{t("tabs.claws")}</h2>
            <p>{t("clawsCatalog.exploreDescription")}</p>
          </div>
          <label class="agents-home__claw-search">
            <span aria-hidden="true">
              <Icon name="search" />
            </span>
            <input
              type="search"
              class="settings-input"
              data-claws-search
              aria-label={t("clawsCatalog.search")}
              placeholder={t("clawsCatalog.searchPlaceholder")}
              value={view.query}
              disabled={!gateway.connected || unavailable()}
              onInput={(event) => search(event.currentTarget.value)}
            />
          </label>
        </div>
        <nav class="agents-home__claw-categories" aria-label={t("clawsCatalog.categories")}>
          <For each={clawCategories}>
            {([slug, label]) => (
              <button
                type="button"
                class={`btn btn--sm${view.category === slug ? " agents-home__claw-category--active" : ""}`}
                aria-pressed={view.category === slug ? "true" : "false"}
                onClick={() => selectCategory(slug)}
              >
                {t(label)}
              </button>
            )}
          </For>
        </nav>
        <Show when={unavailable()}>
          <div class="callout warn" role="status">
            {t("clawsCatalog.unavailable")}
          </div>
        </Show>
        <Show when={view.error}>
          <div class="callout danger" role="alert">
            {view.error}
            <button type="button" class="btn btn--sm" onClick={() => void loadCatalog()}>
              {t("clawsCatalog.retry")}
            </button>
          </div>
        </Show>
        <Show when={view.loading}>
          <div class="agents-home__claw-grid" role="status" aria-label={t("clawsCatalog.loading")}>
            <For each={[0, 1, 2, 3]}>
              {() => <div class="agents-home__claw-skeleton" aria-hidden="true" />}
            </For>
          </div>
        </Show>
        <Show
          when={
            gateway.connected &&
            !unavailable() &&
            !view.loading &&
            !view.error &&
            view.entries.length === 0
          }
        >
          <p class="agents-home__claw-empty">{t("clawsCatalog.empty")}</p>
        </Show>
        <Show when={view.featured.length > 0}>
          <h3 class="agents-home__claw-section-title">{t("clawsCatalog.featured")}</h3>
          <div class="agents-home__claw-grid" data-claws-featured>
            <For each={view.featured} keyed={(entry) => entry.packageName}>
              {(entry) => <ClawCard entry={entry()} onSelect={props.onSelect} />}
            </For>
          </div>
        </Show>
        <Show when={browseEntries().length > 0}>
          <h3 class="agents-home__claw-section-title">
            {view.category
              ? t(
                  clawCategories.find(([slug]) => slug === view.category)?.[1] ??
                    "clawsCatalog.categoryOther",
                )
              : t("clawsCatalog.browseAll")}
          </h3>
          <div class="agents-home__claw-grid" data-claws-results>
            <For each={browseEntries()} keyed={(entry) => entry.packageName}>
              {(entry) => <ClawCard entry={entry()} onSelect={props.onSelect} />}
            </For>
          </div>
        </Show>
      </section>
    </openclaw-claws-explore>
  );
}
