import { createStore, For, onCleanup, Show } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { registerAgentsHomeEnglish } from "../../i18n/locales/en-agents-home.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { searchOfficialClaws, type ClawCatalogEntry } from "./claws-catalog-client.ts";
import "../../styles/agents-home.css";

registerEnglishCatalog(registerAgentsHomeEnglish);

export function ClawsExplore(props: { onSelect?: (entry: ClawCatalogEntry) => void }) {
  const context = useApplication();
  const [view, setView] = createStore<{
    entries: ClawCatalogEntry[];
    query: string;
    loading: boolean;
    error: string | null;
  }>({
    entries: [],
    query: "",
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
    onIdentityChange: () => updateView({ query: "" }),
    invalidateRequests: () => {
      searchRevision += 1;
      clearSearchTimer();
      loadedForConnection = false;
      updateView({ entries: [], loading: false, error: null });
    },
    onSnapshot: () => {
      if (gateway.connected && canSearch() && !loadedForConnection) {
        void loadCatalog();
      }
    },
  });
  onCleanup(clearSearchTimer);

  async function loadCatalog() {
    const scope = gateway.capture();
    if (!scope || !canSearch()) {
      return;
    }
    const revision = ++searchRevision;
    loadedForConnection = true;
    updateView({ entries: [], loading: true, error: null });
    try {
      const entries = await searchOfficialClaws(scope.client, view.query);
      if (gateway.isCurrent(scope) && revision === searchRevision) {
        updateView({ entries });
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
    updateView({ query, entries: [], loading: true, error: null });
    searchTimer = setTimeout(() => {
      searchTimer = null;
      void loadCatalog();
    }, 150);
  }

  const unavailable = () => gateway.connected && !canSearch();
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
        <div class="agents-home__claw-grid">
          <For each={view.entries} keyed={(entry) => entry.packageName}>
            {(entry) => (
              <article class="agents-home__claw-card oc-card" data-claws-entry>
                <button
                  type="button"
                  class="agents-home__claw-card-link"
                  aria-label={`${t("clawsCatalog.review")} ${entry().displayName}`}
                  disabled={!entry().latestVersion}
                  onClick={() => props.onSelect?.(entry())}
                />
                <div class="agents-home__claw-head">
                  <span class="agents-home__claw-art" aria-hidden="true">
                    <Icon name="box" />
                  </span>
                  <div class="agents-home__claw-identity">
                    <h3>{entry().displayName}</h3>
                    <span>{t("clawsCatalog.publisher")}</span>
                  </div>
                  <button
                    type="button"
                    class="btn btn--sm agents-home__claw-add oc-action oc-action-secondary"
                    disabled={!entry().latestVersion}
                    onClick={() => props.onSelect?.(entry())}
                  >
                    {t("clawsCatalog.add")}
                  </button>
                </div>
                <Show when={entry().summary}>
                  <p class="agents-home__claw-summary">{entry().summary}</p>
                </Show>
              </article>
            )}
          </For>
        </div>
      </section>
    </openclaw-claws-explore>
  );
}
