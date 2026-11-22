// Every provider this agent can connect, as rows on the page: no picker dialog in between.
import { createMemo, createSignal, Show } from "solid-js";
import { CatalogDiscoverySearch } from "../../components/solid/catalog-discovery.tsx";
import {
  SettingsEmpty,
  SettingsLoadingSkeleton,
  SettingsSectionHeader,
} from "../../components/solid/settings-ui.tsx";
import { canonicalModelAuthProviderId } from "../../lib/model-auth.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { ModelProviderIcon } from "../../lib/reactive/provider-presentation.tsx";
import { PluginCatalogGrid } from "../plugins/catalog-grid.tsx";
import type { LoginProvider } from "./login-providers.ts";
import "../../styles/plugins.css";

const POPULAR_FALLBACK_SIZE = 8;

/** The ways in, in words, and the one verb the row's button uses. */
function waysIn(provider: LoginProvider, connected: boolean): { summary: string; action: string } {
  const ways = new Set(
    provider.choices.map((choice) =>
      t(
        choice.kind === "secret"
          ? "modelProviders.catalog.token"
          : "modelProviders.catalog.browserSignIn",
      ),
    ),
  );
  if (provider.apiKeyProvider) {
    ways.add(t("modelProviders.status.apiKey"));
  }
  const action = connected
    ? "modelProviders.profiles.addAccount"
    : provider.choices.length === 0
      ? "modelProviders.catalog.addKey"
      : provider.choices.length === 1 && !provider.apiKeyProvider
        ? "modelProviders.catalog.signIn"
        : "modelProviders.catalog.connect";
  return { summary: [...ways].join(" · "), action: t(action) };
}

export function ProviderCatalog(props: {
  providers: LoginProvider[];
  /** Providers the agent already uses; their rows offer another account. */
  connected: ReadonlySet<string>;
  /** Nothing is connected yet: this is the page's first action. */
  first: boolean;
  agentLabel: string;
  /** The provider list is still loading; hold its space instead of calling it empty. */
  loading: boolean;
  disabled: boolean;
  /** A provider link from another page starts the search on it. */
  initialQuery?: string;
  /** The page focuses the search when a link asks to connect a provider. */
  searchRef: (element: HTMLInputElement) => void;
  onConnect: (providerId: string) => void;
  onDiscover: () => void;
  discoverDisabled: boolean;
}) {
  // Local draft: only a different deep-linked provider re-derives it.
  const routeQuery = createMemo(() => props.initialQuery ?? "");
  const [query, setQuery] = createSignal(() => routeQuery());
  const [showAll, setShowAll] = createSignal(false);
  const popular = createMemo(() => {
    const featured = props.providers.filter((provider) => provider.featured);
    return featured.length ? featured : props.providers.slice(0, POPULAR_FALLBACK_SIZE);
  });
  const needle = () => query().trim().toLocaleLowerCase().normalize("NFC");
  const shown = createMemo(() =>
    needle()
      ? props.providers.filter((provider) =>
          [provider.id, provider.label, ...provider.choices.map((choice) => choice.label)].some(
            (text) => text.toLocaleLowerCase().normalize("NFC").includes(needle()),
          ),
        )
      : showAll()
        ? props.providers
        : popular(),
  );
  return (
    <section class="settings-section model-providers__catalog" data-models-catalog>
      <SettingsSectionHeader
        title={t(
          props.first ? "modelProviders.catalog.firstTitle" : "modelProviders.catalog.title",
        )}
        description={
          props.first
            ? t("modelProviders.catalog.firstDescription")
            : t("modelProviders.catalog.description", { agent: props.agentLabel })
        }
        actions={
          <button
            type="button"
            class="btn btn--sm btn--ghost"
            data-models-login-discover
            disabled={props.discoverDisabled}
            onClick={() => props.onDiscover()}
          >
            {t("modelProviders.catalog.discover")}
          </button>
        }
      />
      <div class="plugin-catalog-results plugin-catalog-results--rows">
        <CatalogDiscoverySearch>
          <input
            ref={(element) => props.searchRef(element)}
            type="search"
            class="settings-input"
            data-models-catalog-search
            autocomplete="off"
            aria-label={t("modelProviders.search")}
            placeholder={t("modelProviders.search")}
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </CatalogDiscoverySearch>
        <Show
          when={shown().length > 0}
          fallback={
            props.loading ? (
              <SettingsLoadingSkeleton rows={2} />
            ) : (
              <SettingsEmpty
                message={t(
                  needle() ? "modelProviders.noMatches" : "modelProviders.login.noProviders",
                )}
              />
            )
          }
        >
          <PluginCatalogGrid items={shown()}>
            {(provider, contentRef) => {
              const ways = createMemo(() =>
                waysIn(
                  provider(),
                  [provider().id, ...provider().authProviders].some((id) =>
                    props.connected.has(canonicalModelAuthProviderId(id)),
                  ),
                ),
              );
              return (
                <article
                  class="plugin-catalog-card plugin-catalog-row"
                  data-models-catalog-provider={provider().id}
                >
                  <div class="plugin-catalog-card__content" ref={contentRef}>
                    <div class="plugin-catalog-row__main">
                      <span class="plugin-catalog-card__art plugin-catalog-card__art--fallback">
                        <ModelProviderIcon provider={provider().id} class="model-providers__icon" />
                      </span>
                      <div class="plugin-catalog-row__text">
                        <div class="plugin-card-title-row">
                          <h3>{provider().label}</h3>
                        </div>
                        <p class="installed-plugins-card__summary">{ways().summary}</p>
                      </div>
                      <div class="plugin-catalog-card__action">
                        <button
                          type="button"
                          class="btn btn--sm plugin-catalog-card__install oc-action oc-action-secondary"
                          disabled={props.disabled}
                          aria-label={t("modelProviders.actionNamed", {
                            action: ways().action,
                            name: provider().label,
                          })}
                          onClick={() => props.onConnect(provider().id)}
                        >
                          {ways().action}
                        </button>
                      </div>
                    </div>
                  </div>
                </article>
              );
            }}
          </PluginCatalogGrid>
        </Show>
        <Show when={!needle() && props.providers.length > popular().length}>
          <button
            type="button"
            class="btn btn--sm btn--ghost model-providers__catalog-more"
            aria-expanded={showAll() ? "true" : "false"}
            onClick={() => setShowAll(!showAll())}
          >
            {showAll()
              ? t("modelProviders.catalog.showPopular")
              : t("modelProviders.catalog.showAll", { count: String(props.providers.length) })}
          </button>
        </Show>
      </div>
    </section>
  );
}
