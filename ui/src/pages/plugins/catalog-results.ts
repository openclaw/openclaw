import { html, nothing, svg, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import { strokeIcon } from "../../components/icons-tools.ts";
import { icons } from "../../components/icons.ts";
import { renderSettingsLoadingSkeleton } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import type {
  PluginDiscoveryCategory,
  PluginDiscoveryEntry,
  PluginDiscoveryResult,
} from "../../lib/plugins/index.ts";
import {
  renderPluginCardIdentity,
  renderPluginCardSummary,
  renderPluginStateStatus,
} from "./plugin-card.ts";
import { resolvePluginCatalogIconUrl } from "./presentation.ts";

export type PluginDiscoveryIntent = "all" | "bundled" | "trending" | "official" | "featured";

export type PluginCatalogResultsProps = {
  connected: boolean;
  loading: boolean;
  result: PluginDiscoveryResult | null;
  error: string | null;
  remoteError: string | null;
  categories: readonly PluginDiscoveryCategory[];
  featured: readonly PluginDiscoveryEntry[];
  featuredLoading: boolean;
  trending: readonly PluginDiscoveryEntry[];
  trendingLoading: boolean;
  loadingMore: boolean;
  loadMoreError: string | null;
  intent: PluginDiscoveryIntent;
  category: string | null;
  query: string;
  iconUrls: Readonly<Record<string, string>>;
  pluginIconUrls: Readonly<Record<string, string>>;
  canInstall: boolean;
  entryHref: (id: string) => string;
  onIntentChange: (intent: PluginDiscoveryIntent) => void;
  onCategoryChange: (category: string | null) => void;
  onQueryChange: (query: string) => void;
  onOpenEntry: (id: string) => void;
  onInstall: (id: string) => void;
  onLoadMore: () => void;
  onRetry: () => void;
};

const SECTION_SIZE = 8;

// Category-only SVGs stay in the deferred Plugins page, outside the startup icon registry.
const CATEGORY_ICONS: Readonly<Record<string, TemplateResult>> = {
  activity: icons.activity,
  "book-open": icons.book,
  brain: icons.brain,
  bot: icons.bot,
  database: strokeIcon(svg` <ellipse cx="12" cy="5" rx="9" ry="3" />
    <path d="M3 5V19A9 3 0 0 0 21 19V5" />
    <path d="M3 12A9 3 0 0 0 21 12" />`),
  "git-branch": icons.gitPullRequest,
  globe: icons.globe,
  "message-circle": icons.messageSquare,
  "message-square": icons.messageSquare,
  package: icons.box,
  palette: icons.palette,
  shield: icons.shield,
  wrench: icons.settings,
  plug: icons.plug,
  "code-xml": strokeIcon(svg` <path d="m18 16 4-4-4-4" />
    <path d="m6 8-4 4 4 4" />
    <path d="m14.5 4-5 16" />`),
  server: icons.server,
  files: strokeIcon(svg` <path d="M15 2h-4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8" />
    <path d="M16.706 2.706A2.4 2.4 0 0 0 15 2v5a1 1 0 0 0 1 1h5a2.4 2.4 0 0 0-.706-1.706z" />
    <path d="M5 7a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 1.732-1" />`),
  inbox: icons.inbox,
  "list-todo": strokeIcon(svg` <path d="M13 5h8" />
    <path d="M13 12h8" />
    <path d="M13 19h8" />
    <path d="m3 17 2 2 4-4" />
    <rect x="3" y="4" width="6" height="6" rx="1" />`),
  "calendar-days": strokeIcon(svg` <path d="M8 2v3" />
    <path d="M16 2v3" />
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18" />
    <path d="M8 13h.01" />
    <path d="M12 13h.01" />
    <path d="M16 13h.01" />
    <path d="M8 17h.01" />
    <path d="M12 17h.01" />
    <path d="M16 17h.01" />`),
  "wallet-cards":
    strokeIcon(svg` <path d="M3 11h3.75a2 2 0 0 1 1.6.8l.45.6a4 4 0 0 0 6.4 0l.45-.6a2 2 0 0 1 1.6-.8H21" />
    <path d="M3 7h18" />
    <rect x="3" y="3" width="18" height="18" rx="2" />`),
  megaphone:
    strokeIcon(svg` <path d="M11 6a13 13 0 0 0 8.4-2.8A1 1 0 0 1 21 4v12a1 1 0 0 1-1.6.8A13 13 0 0 0 11 14H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" />
    <path d="M6 14a12 12 0 0 0 2.4 7.2 2 2 0 0 0 3.2-2.4A8 8 0 0 1 10 14" />
    <path d="M8 6v8" />`),
  "chart-no-axes-combined": strokeIcon(svg` <path d="M12 16v5" />
    <path d="M16 14.639V21" />
    <path d="M20 10.656V21" />
    <path d="m22 3-8.646 8.646a.5.5 0 0 1-.708 0L9.354 8.354a.5.5 0 0 0-.707 0L2 15" />
    <path d="M4 18.463V21" />
    <path d="M8 14.656V21" />`),
  workflow: strokeIcon(svg` <rect width="8" height="8" x="3" y="3" rx="2" />
    <path d="M7 11v4a2 2 0 0 0 2 2h4" />
    <rect width="8" height="8" x="13" y="13" rx="2" />`),
  search: icons.search,
};

function categoryIcon(icon: string | undefined): TemplateResult {
  return (icon && CATEGORY_ICONS[icon]) || icons.box;
}

function renderCatalogIcon(
  plugin: PluginDiscoveryEntry,
  props: PluginCatalogResultsProps,
): TemplateResult {
  const iconUrl = resolvePluginCatalogIconUrl(
    {
      pluginId: plugin.local.pluginId,
      packageName: plugin.catalog.packageName,
      imageUrl: plugin.catalog.imageUrl,
    },
    props,
  );
  return iconUrl
    ? html`<img class="plugins-icon" src=${iconUrl} alt="" loading="lazy" decoding="async" />`
    : categoryIcon(plugin.catalog.icon);
}

export function formatCompactCount(value: number): string {
  if (value < 1_000) {
    return new Intl.NumberFormat().format(value);
  }
  if (value < 1_000_000) {
    const thousands = value / 1_000;
    return `${thousands >= 100 ? Math.round(thousands) : Number(thousands.toFixed(1))}k`;
  }
  const millions = value / 1_000_000;
  return `${millions >= 100 ? Math.round(millions) : Number(millions.toFixed(1))}m`;
}

function renderCatalogCard(
  plugin: PluginDiscoveryEntry,
  props: PluginCatalogResultsProps,
): TemplateResult {
  const installedState = plugin.local.state === "not-installed" ? null : plugin.local.state;
  const installed = plugin.local.installed && installedState !== null;
  const canInstall = props.canInstall && plugin.local.action === "install";
  return html`<article
    class="plugin-catalog-card oc-card oc-card-interactive"
    data-plugin-id=${plugin.id}
  >
    <a
      class="plugin-catalog-card__primary-link"
      href=${props.entryHref(plugin.id)}
      aria-label=${plugin.catalog.name}
      @click=${(event: MouseEvent) => {
        if (!shouldHandleNavigationClick(event)) {
          return;
        }
        event.preventDefault();
        props.onOpenEntry(plugin.id);
      }}
    ></a>
    <div class="plugin-catalog-card__head">
      <div class="installed-plugins-card__head">
        <span
          class="installed-plugins-card__art plugin-catalog-card__art"
          aria-hidden="true"
          data-plugin-icon-id=${plugin.local.pluginId ?? nothing}
        >
          ${renderCatalogIcon(plugin, props)}
        </span>
        ${renderPluginCardIdentity({
          name: plugin.catalog.name,
          attribution: {
            ...(plugin.catalog.author ? { author: plugin.catalog.author } : {}),
            official: plugin.catalog.official,
          },
          linkedAuthor: true,
        })}
      </div>
      <div class="plugin-catalog-card__action">
        ${
          installed
            ? renderPluginStateStatus(installedState, "plugin-catalog-card__status")
            : html`<button
                type="button"
                class="btn btn--sm plugin-catalog-card__install oc-action oc-action-secondary"
                aria-label=${t("pluginsPage.installNamed", { name: plugin.catalog.name })}
                ?disabled=${!canInstall}
                @click=${(event: MouseEvent) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (canInstall) {
                    props.onInstall(plugin.id);
                  }
                }}
              >
                ${t("pluginsPage.install")}
              </button>`
        }
      </div>
    </div>
    ${renderPluginCardSummary(plugin.catalog.summary || t("pluginsPage.optionalCapability"))}
  </article>`;
}

function renderError(error: string, onRetry: () => void): TemplateResult {
  return html`<div class="callout danger oc-banner oc-banner-error" role="alert">
    <span>${formatUiExternalText(error)}</span>
    <button
      type="button"
      class="btn btn--sm oc-action oc-action-secondary oc-banner-action"
      @click=${onRetry}
    >
      ${t("pluginsPage.tryAgain")}
    </button>
  </div>`;
}

function renderSection(params: {
  id: string;
  title: string;
  items: readonly PluginDiscoveryEntry[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onViewAll?: () => void;
  props: PluginCatalogResultsProps;
}): TemplateResult | typeof nothing {
  if (!params.loading && !params.error && params.items.length === 0) {
    return nothing;
  }
  return html`<section
    class="plugin-catalog-section ${params.onViewAll ? "plugin-catalog-section--expandable" : ""}"
    data-catalog-section=${params.id}
  >
    <header class="plugin-catalog-section__header">
      <h2>${params.title}</h2>
      ${
        params.onViewAll
          ? html`<button
              type="button"
              class="btn btn--sm plugin-catalog-section__view-all oc-action oc-action-ghost"
              @click=${params.onViewAll}
            >
              ${t("pluginsPage.viewAllInstalledPlugins")}
            </button>`
          : nothing
      }
    </header>
    ${
      params.loading
        ? renderSettingsLoadingSkeleton({ rows: 4, carapace: true })
        : params.error && params.onRetry
          ? renderError(params.error, params.onRetry)
          : html`<div class="plugin-catalog-grid">
              ${repeat(
                params.onViewAll ? params.items.slice(0, SECTION_SIZE) : params.items,
                (plugin) => plugin.id,
                (plugin) => renderCatalogCard(plugin, params.props),
              )}
            </div>`
    }
  </section>`;
}

function renderCategoryChips(props: PluginCatalogResultsProps): TemplateResult {
  const activeAll = props.intent === "all" && props.category === null;
  return html`<div class="plugin-catalog-chips" aria-label=${t("pluginsPage.categoriesLabel")}>
    <button
      type="button"
      class="plugin-catalog-chip ${activeAll ? "is-active" : ""}"
      aria-pressed=${activeAll}
      @click=${() => props.onIntentChange("all")}
    >
      <span aria-hidden="true">${icons.layoutGrid}</span>${t("pluginsPage.intentAll")}
    </button>
    <button
      type="button"
      class="plugin-catalog-chip ${props.intent === "featured" ? "is-active" : ""}"
      aria-pressed=${props.intent === "featured"}
      @click=${() => props.onIntentChange("featured")}
    >
      <span aria-hidden="true">${icons.star}</span>${t("pluginsPage.featuredTitle")}
    </button>
    <button
      type="button"
      class="plugin-catalog-chip ${props.intent === "trending" ? "is-active" : ""}"
      aria-pressed=${props.intent === "trending"}
      @click=${() => props.onIntentChange("trending")}
    >
      <span aria-hidden="true">${icons.barChart}</span>${t("pluginsPage.intentTrending")}
    </button>
    ${repeat(
      props.categories.toSorted((left, right) => left.order - right.order),
      (item) => item.slug,
      (item) => html`<button
        type="button"
        class="plugin-catalog-chip ${props.category === item.slug ? "is-active" : ""}"
        aria-pressed=${props.category === item.slug}
        @click=${() => props.onCategoryChange(item.slug)}
      >
        <span aria-hidden="true">${categoryIcon(item.icon)}</span>${item.label}
      </button>`,
    )}
  </div>`;
}

function renderRawResults(props: PluginCatalogResultsProps): TemplateResult {
  const items = props.result?.items ?? [];
  if (props.loading) {
    return renderSettingsLoadingSkeleton({
      label: t("pluginsPage.loadingDiscovery"),
      rows: 8,
      carapace: true,
    });
  }
  if (props.error) {
    return renderError(props.error, props.onRetry);
  }
  if (!props.connected) {
    return html`<p class="plugin-catalog-results__empty">${t("pluginsPage.discoveryOffline")}</p>`;
  }
  if (items.length === 0) {
    return html`<p class="plugin-catalog-results__empty">
      ${t("pluginsPage.noDiscoveryResults")}
    </p>`;
  }
  return html`
    <div class="plugin-catalog-grid plugin-catalog-grid--results">
      ${repeat(
        items,
        (plugin) => plugin.id,
        (plugin) => renderCatalogCard(plugin, props),
      )}
    </div>
    ${props.loadMoreError ? renderError(props.loadMoreError, props.onLoadMore) : nothing}
    ${
      props.result?.nextCursor
        ? html`<div class="plugin-catalog-load-more">
            <button
              type="button"
              class="btn btn--sm oc-action oc-action-secondary"
              ?disabled=${props.loadingMore}
              @click=${props.onLoadMore}
            >
              ${props.loadingMore ? t("pluginsPage.loadingMore") : t("pluginsPage.loadMore")}
            </button>
          </div>`
        : nothing
    }
  `;
}

function renderGroupedCatalog(props: PluginCatalogResultsProps): TemplateResult {
  const items = props.result?.items ?? [];
  const categories = props.categories.toSorted((left, right) => left.order - right.order);
  const categorySlugs = new Set(categories.map((category) => category.slug));
  const uncategorized = items.filter(
    (plugin) => !plugin.catalog.categories.some((category) => categorySlugs.has(category)),
  );
  const hasAnySection = props.featured.length > 0 || props.trending.length > 0 || items.length > 0;
  if (
    !hasAnySection &&
    !props.loading &&
    !props.featuredLoading &&
    !props.trendingLoading &&
    !props.error &&
    !props.remoteError
  ) {
    return html`<p class="plugin-catalog-results__empty">
      ${t("pluginsPage.noDiscoveryResults")}
    </p>`;
  }
  return html`
    ${props.error ? renderError(props.error, props.onRetry) : nothing}
    ${renderSection({
      id: "featured",
      title: t("pluginsPage.featuredTitle"),
      items: props.featured,
      loading: props.featuredLoading,
      onViewAll: () => props.onIntentChange("featured"),
      props,
    })}
    ${renderSection({
      id: "trending",
      title: t("pluginsPage.intentTrending"),
      items: props.trending,
      loading: props.trendingLoading,
      onViewAll: () => props.onIntentChange("trending"),
      props,
    })}
    ${repeat(
      categories,
      (category) => category.slug,
      (category) =>
        renderSection({
          id: category.slug,
          title: category.label,
          items: items.filter((plugin) => plugin.catalog.categories.includes(category.slug)),
          onViewAll: () => props.onCategoryChange(category.slug),
          props,
        }),
    )}
    ${renderSection({
      id: "uncategorized",
      title: t("pluginsPage.categoryUncategorized"),
      items: uncategorized,
      props,
    })}
  `;
}

export function renderPluginCatalogResults(props: PluginCatalogResultsProps): TemplateResult {
  const hasQuery = Boolean(props.query.trim());
  const grouped = !hasQuery && props.intent === "all" && props.category === null;
  return html`<section class="plugin-catalog-results" aria-label=${t("pluginsPage.exploreTitle")}>
    <label class="plugin-catalog-search">
      <span aria-hidden="true">${icons.search}</span>
      <input
        type="search"
        class="oc-input"
        autofocus
        aria-label=${t("pluginsPage.searchPlugins")}
        placeholder=${t("pluginsPage.searchPlugins")}
        .value=${props.query}
        ${ref((element) => {
          if (element instanceof HTMLInputElement && !element.dataset.autofocused) {
            element.dataset.autofocused = "true";
            element.focus();
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                if (element.isConnected) {
                  element.focus();
                }
              }),
            );
          }
        })}
        @input=${(event: Event) => {
          if (event.currentTarget instanceof HTMLInputElement) {
            props.onQueryChange(event.currentTarget.value);
          }
        }}
      />
    </label>
    ${renderCategoryChips(props)}
    ${
      props.remoteError
        ? html`<div class="callout warning oc-banner" role="status">
            <span>${formatUiExternalText(props.remoteError)}</span>
            <button
              type="button"
              class="btn btn--sm oc-action oc-action-secondary oc-banner-action"
              @click=${props.onRetry}
            >
              ${t("pluginsPage.tryAgain")}
            </button>
          </div>`
        : nothing
    }
    <div class="plugin-catalog-results__body">
      ${grouped ? renderGroupedCatalog(props) : renderRawResults(props)}
    </div>
  </section>`;
}
