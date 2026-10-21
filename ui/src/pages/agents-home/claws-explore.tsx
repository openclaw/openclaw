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
import { Icon } from "../../components/solid/icon.tsx";
import { registerAgentsHomeEnglish } from "../../i18n/locales/en-agents-home.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { ClawArtwork } from "./claw-artwork.tsx";
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
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resume: (() => void) | undefined;
    const ready = delay
      ? new Promise<void>((resolve) => {
          resume = resolve;
          timer = setTimeout(resolve, delay);
        })
      : undefined;
    cancelSearch = () => {
      cancelled = true;
      clearTimeout(timer);
      resume?.();
    };
    setRequest({
      scope,
      query,
      category,
      ready,
      isCurrent: () =>
        !cancelled &&
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
                class={[
                  "btn btn--sm",
                  { "agents-home__claw-category--active": view.category === slug },
                ]}
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
        <Show when={request()} keyed>
          {(current) => {
            const result = createMemo(async () => {
              if (current.ready) {
                await current.ready;
              }
              if (!current.isCurrent()) {
                return { entries: [], featured: [] };
              }
              const [entries, featured] = await Promise.all([
                searchClaws(current.scope.client, current.query, undefined, {
                  category: current.category || undefined,
                }),
                !current.query.trim() && !current.category
                  ? searchClaws(current.scope.client, "", undefined, { featured: true })
                  : Promise.resolve([]),
              ]);
              return { entries, featured };
            });
            const browseEntries = createMemo(() => {
              const data = result();
              const featuredNames = new Set(data.featured.map((entry) => entry.packageName));
              return data.entries.filter((entry) => !featuredNames.has(entry.packageName));
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
                      class="agents-home__claw-grid"
                      role="status"
                      aria-label={t("clawsCatalog.loading")}
                    >
                      <Repeat count={4}>
                        {() => <div class="agents-home__claw-skeleton" aria-hidden="true" />}
                      </Repeat>
                    </div>
                  }
                >
                  <Show when={gateway.connected && !unavailable() && result().entries.length === 0}>
                    <p class="agents-home__claw-empty">{t("clawsCatalog.empty")}</p>
                  </Show>
                  <Show when={result().featured.length > 0}>
                    <h3 class="agents-home__claw-section-title">{t("clawsCatalog.featured")}</h3>
                    <div class="agents-home__claw-grid" data-claws-featured>
                      <For each={result().featured} keyed={(entry) => entry.packageName}>
                        {(entry) => <ClawCard entry={entry()} onSelect={props.onSelect} />}
                      </For>
                    </div>
                  </Show>
                  <Show when={browseEntries().length > 0}>
                    <h3 class="agents-home__claw-section-title">
                      {current.category
                        ? t(
                            clawCategories.find(([slug]) => slug === current.category)?.[1] ??
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
                </Loading>
              </Errored>
            );
          }}
        </Show>
      </section>
    </openclaw-claws-explore>
  );
}
