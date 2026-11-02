import type { JSX } from "@solidjs/web";
import { createMemo, Errored, For, latest, Loading, onSettled, Repeat, Reveal } from "solid-js";
import { comparePluginCatalogEntries } from "../../../../packages/plugin-package-contract/src/catalog-order.js";
import {
  CatalogDiscoveryChip,
  CatalogDiscoveryChips,
  CatalogDiscoverySearch,
  CatalogDiscoverySection,
} from "../../components/solid/catalog-discovery.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { PanelEmptyState } from "../../components/solid/panel-empty-state.tsx";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import { handleNavigationClick } from "../../lib/navigation-click.ts";
import type { PageReadResult } from "../../lib/page-request.ts";
import type {
  PluginCatalogItem,
  PluginDiscoveryEntry,
  PluginInstallRequest,
} from "../../lib/plugins/index.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { categoryIcon } from "./catalog-category-icon.tsx";
import { PluginCatalogGrid } from "./catalog-grid.tsx";
import { PluginCatalogSkeleton, renderCatalogGridSkeleton } from "./catalog-skeleton.tsx";
import { PluginArtTile } from "./consent-dialog.tsx";
import { PluginInstallAction, type PluginInstallActionProps } from "./install-action.tsx";
import type { PluginInstallProgress } from "./install-progress.ts";
import {
  renderPluginAuthor,
  PluginCardSummary,
  renderPluginOfficialBadge,
  renderPluginStateStatus,
} from "./plugin-card.tsx";
import type { PluginDiscoveryIntent, PluginDiscoveryState } from "./plugin-discovery.ts";
import { renderPluginRowMessage, type PluginRowMessage } from "./plugin-row-message.tsx";
import type { PluginMutationAction } from "./plugins-page-model.ts";
import { resolvePluginCatalogIconUrl } from "./presentation.ts";

export type PluginCatalogResultsProps = PluginDiscoveryState & {
  registerInstallAction?: PluginInstallActionProps["registerInstallAction"];
  registerIcon?: (readId: () => string) => () => void;
  connected: boolean;
  onRetryCategories: () => void;
  iconUrls: Readonly<Record<string, string>>;
  pluginIconUrls: Readonly<Record<string, string>>;
  iconLoading?: (url: string) => boolean;
  pluginIconLoading?: (pluginId: string) => boolean;
  canInstall: boolean;
  busy?: Readonly<Record<string, PluginMutationAction>>;
  installProgress?: ReadonlyMap<string, PluginInstallProgress>;
  /** Installed inventory; publishes local state before catalog pages are read again. */
  inventory?: readonly PluginCatalogItem[];
  messages?: Readonly<Record<string, PluginRowMessage>>;
  onContinueInstall?: (id: string, request: PluginInstallRequest) => void;
  entryHref: (id: string) => string;
  onIntentChange: (intent: PluginDiscoveryIntent) => void;
  onCategoryChange: (category: string | null) => void;
  onQueryChange: (query: string) => void;
  onOpenEntry: (id: string) => void;
  onInstall: (id: string) => void;
  onLoadMore: () => void;
  onRetry: () => void;
};

type CatalogResultsState = PluginCatalogResultsProps & {
  installedByCatalogId: ReadonlyMap<string, PluginCatalogItem>;
};

const SECTION_SIZE = 8;
// Estimate the current registry footprint without duplicating its taxonomy.
// The actual labels, ordering, and count still come only from ClawHub.
const CATEGORY_SKELETON_COUNT = 22;
const PROMOTED_SECTIONS = [
  ["featured", "pluginsPage.featuredTitle", "star"],
  ["trending", "pluginsPage.intentTrending", "barChart"],
] as const;

function CatalogIcon(props: {
  plugin: PluginDiscoveryEntry;
  state: PluginCatalogResultsProps;
}): JSX.Element {
  const iconUrl = createMemo(() =>
    resolvePluginCatalogIconUrl(
      {
        pluginId: props.plugin.local.pluginId,
        imageUrl: props.plugin.catalog.imageUrl,
      },
      props.state,
    ),
  );
  return (
    <PluginArtTile
      registerIcon={props.state.registerIcon}
      slug={props.plugin.local.pluginId ?? props.plugin.id}
      name={props.plugin.catalog.name}
      iconUrl={iconUrl() ?? undefined}
      whiteBackground={props.plugin.catalog.official && Boolean(iconUrl())}
      loading={Boolean(
        (props.plugin.local.pluginId &&
          props.state.pluginIconLoading?.(props.plugin.local.pluginId)) ||
        (props.plugin.catalog.imageUrl && props.state.iconLoading?.(props.plugin.catalog.imageUrl)),
      )}
    />
  );
}

export function formatCompactCount(value: number): string {
  if (value < 1_000) {
    return new Intl.NumberFormat().format(value);
  }
  const scale = value >= 999_500_000 ? 1_000_000_000 : value >= 999_500 ? 1_000_000 : 1_000;
  const count = value / scale;
  const suffix = scale === 1_000 ? "k" : scale === 1_000_000 ? "m" : "b";
  return `${count >= 100 ? Math.round(count) : Number(count.toFixed(1))}${suffix}`;
}

function CatalogCard(props: {
  plugin: PluginDiscoveryEntry;
  state: CatalogResultsState;
  contentRef?: (element: HTMLDivElement) => void;
}): JSX.Element {
  const inventoryEntry = createMemo(() => props.state.installedByCatalogId.get(props.plugin.id));
  const installedState = () => {
    const state = inventoryEntry()?.state ?? props.plugin.local.state;
    return state === "not-installed" ? null : state;
  };
  const progress = () => props.state.installProgress?.get(`install:${props.plugin.id}`);
  const installing = () => Boolean(progress() && progress()?.finishedAt === undefined);
  const installed = () =>
    (inventoryEntry() !== undefined || props.plugin.local.installed) &&
    installedState() !== null &&
    !installing();
  const busy = () => Boolean(props.state.busy?.[`install:${props.plugin.id}`]);
  const canInstall = () =>
    props.state.canInstall &&
    props.plugin.local.action === "install" &&
    !busy() &&
    !props.state.messages?.[`install:${props.plugin.id}`]?.savedInstall;
  return (
    <article
      class="plugin-catalog-card oc-card oc-card-interactive"
      data-plugin-id={props.plugin.id}
    >
      <a
        class="plugin-catalog-card__primary-link"
        href={props.state.entryHref(props.plugin.id)}
        aria-label={props.plugin.catalog.name}
        onClick={(event: MouseEvent) =>
          handleNavigationClick(event, () => props.state.onOpenEntry(props.plugin.id))
        }
      />
      <div class="plugin-catalog-card__content" ref={props.contentRef}>
        <div class="plugin-catalog-card__head">
          <div class="installed-plugins-card__head">
            <span
              class="installed-plugins-card__art plugin-catalog-card__art"
              aria-hidden="true"
              data-plugin-icon-id={props.plugin.local.pluginId ?? undefined}
            >
              <CatalogIcon plugin={props.plugin} state={props.state} />
            </span>
            <div class="installed-plugins-card__identity">
              <div class="plugin-card-title-row">
                <h3>{props.plugin.catalog.name}</h3>
                {props.plugin.catalog.official ? renderPluginOfficialBadge() : undefined}
                <div class="plugin-catalog-card__action">
                  {installed() ? (
                    renderPluginStateStatus(installedState()!, "plugin-catalog-card__status")
                  ) : (
                    <PluginInstallAction
                      registerInstallAction={props.state.registerInstallAction}
                      buttonClass={
                        "btn btn--sm plugin-catalog-card__install oc-action oc-action-secondary"
                      }
                      pluginName={props.plugin.catalog.name}
                      busy={busy()}
                      disabled={!canInstall()}
                      progress={progress()}
                      onInstall={() => props.state.onInstall(props.plugin.id)}
                    />
                  )}
                </div>
              </div>
              {renderPluginAuthor(props.plugin.catalog.author)}
            </div>
          </div>
        </div>
        <PluginCardSummary
          summary={props.plugin.catalog.summary || t("pluginsPage.optionalCapability")}
        />
        {renderPluginRowMessage(props.state.messages?.[`install:${props.plugin.id}`], {
          busy: busy(),
          onContinue:
            props.state.canInstall && props.state.onContinueInstall
              ? (request) => props.state.onContinueInstall?.(props.plugin.id, request)
              : undefined,
        })}
      </div>
    </article>
  );
}

function renderError(error: string, onRetry: () => void, warning = false): JSX.Element {
  return (
    <div
      class={[
        "callout",
        warning ? "warning" : "danger",
        "oc-banner",
        { "oc-banner-error": !warning },
      ]}
      role={warning ? "status" : "alert"}
    >
      <span>{formatUiExternalText(error)}</span>
      <button
        type="button"
        class="btn btn--sm oc-action oc-action-secondary oc-banner-action"
        onClick={() => onRetry()}
      >
        {t("pluginsPage.tryAgain")}
      </button>
    </div>
  );
}

function createCatalogRead(
  source: () => Promise<PageReadResult> | null,
  readError?: () => string | null,
) {
  // Unrelated artwork and install publications must not restart readiness.
  const receipt = createMemo(() => ({ promise: source() }), {
    equals: (previous, next) => previous.promise === next.promise,
  });
  const error = createMemo(() => readError?.());
  const ready = createMemo(() => {
    const pending = receipt().promise;
    const message = error();
    return Promise.resolve(pending).then((result) => {
      if (result) {
        throw result.error;
      }
      if (message) {
        throw new Error(message);
      }
      return true;
    });
  });
  return { ready, receipt };
}

function CatalogSection(params: {
  id: string;
  title: string;
  items: readonly PluginDiscoveryEntry[];
  loading?: boolean;
  onViewAll?: () => void;
  state: CatalogResultsState;
}): JSX.Element {
  return (
    <>
      {params.loading || params.items.length > 0 ? (
        <CatalogDiscoverySection
          id={params.id}
          title={params.title}
          onViewAll={params.onViewAll ? () => params.onViewAll?.() : undefined}
          viewAllLabel={t("pluginsPage.viewAllInstalledPlugins")}
        >
          {params.loading ? (
            renderCatalogGridSkeleton({ cards: SECTION_SIZE })
          ) : params.onViewAll ? (
            <div class="plugin-catalog-grid">
              <For each={params.items.slice(0, SECTION_SIZE)} keyed={(plugin) => plugin.id}>
                {(plugin) => <CatalogCard plugin={plugin()} state={params.state} />}
              </For>
            </div>
          ) : (
            <PluginCatalogGrid items={params.items}>
              {(plugin, contentRef) => (
                <CatalogCard plugin={plugin()} state={params.state} contentRef={contentRef} />
              )}
            </PluginCatalogGrid>
          )}
        </CatalogDiscoverySection>
      ) : undefined}
    </>
  );
}

function BuiltinCategoryChips(props: PluginCatalogResultsProps): JSX.Element {
  return (
    <For each={[["all", "pluginsPage.intentAll", "layoutGrid"], ...PROMOTED_SECTIONS] as const}>
      {([intent, label, icon]) => (
        <CatalogDiscoveryChip
          active={props.intent === intent && (intent !== "all" || props.category === null)}
          onClick={() => props.onIntentChange(intent)}
          icon={<Icon name={icon} />}
        >
          {t(label)}
        </CatalogDiscoveryChip>
      )}
    </For>
  );
}

function CategoryChips(props: PluginCatalogResultsProps): JSX.Element {
  const recordedError = createMemo(() => props.categoriesError);
  const { ready, receipt } = createCatalogRead(() => props.reads.categories, recordedError);
  const sourceCategories = createMemo(() => props.categories);
  const categories = createMemo(() =>
    sourceCategories()
      .filter((category) => category.slug !== "other")
      .toSorted((left, right) => left.order - right.order),
  );
  return (
    <Loading
      on={[recordedError(), receipt().promise]}
      fallback={
        <CatalogDiscoveryChips label={t("pluginsPage.categoriesLabel")}>
          <BuiltinCategoryChips {...props} />
          <span class="sr-only" role="status">
            {t("pluginsPage.loadingCategories")}
          </span>
          <Repeat count={CATEGORY_SKELETON_COUNT}>
            {() => <span class="skeleton plugin-catalog-chip--skeleton" aria-hidden="true" />}
          </Repeat>
        </CatalogDiscoveryChips>
      }
    >
      <Errored
        fallback={(error, reset) => (
          <>
            <CatalogDiscoveryChips label={t("pluginsPage.categoriesLabel")}>
              <BuiltinCategoryChips {...props} />
            </CatalogDiscoveryChips>
            {renderError(formatUiError(error()), () => {
              props.onRetryCategories();
              reset();
            })}
          </>
        )}
      >
        <CatalogDiscoveryChips label={t("pluginsPage.categoriesLabel")}>
          <BuiltinCategoryChips {...props} />
          {ready() && (
            <For each={categories()} keyed={(item) => item.slug}>
              {(item) => (
                <CatalogDiscoveryChip
                  active={props.category === item().slug}
                  onClick={() => props.onCategoryChange(item().slug)}
                  icon={categoryIcon(item().icon)}
                >
                  {item().label}
                </CatalogDiscoveryChip>
              )}
            </For>
          )}
        </CatalogDiscoveryChips>
      </Errored>
    </Loading>
  );
}

function LoadMoreButton(props: PluginCatalogResultsProps & { pending: boolean }): JSX.Element {
  return (
    <>
      {props.result?.nextCursor ? (
        <div class="plugin-catalog-load-more">
          <button
            type="button"
            class="btn btn--sm oc-action oc-action-secondary"
            disabled={props.pending}
            onClick={() => props.onLoadMore()}
          >
            {t(props.pending ? "pluginsPage.loadingMore" : "pluginsPage.loadMore")}
          </button>
        </div>
      ) : undefined}
    </>
  );
}

function LoadMore(props: PluginCatalogResultsProps): JSX.Element {
  const { ready, receipt } = createCatalogRead(() => props.reads.more);
  return (
    <Loading on={receipt().promise} fallback={<LoadMoreButton {...props} pending={true} />}>
      <Errored
        fallback={(error, reset) => (
          <>
            {renderError(formatUiError(error()), () => {
              props.onLoadMore();
              reset();
            })}
            <LoadMoreButton {...props} pending={false} />
          </>
        )}
      >
        {ready() && (
          <>
            {props.loadMoreError ? renderError(props.loadMoreError, props.onLoadMore) : undefined}
            <LoadMoreButton {...props} pending={false} />
          </>
        )}
      </Errored>
    </Loading>
  );
}

function renderCatalogEmptyState(): JSX.Element {
  return (
    <PanelEmptyState
      icon={<Icon name="search" />}
      heading={t("pluginsPage.noDiscoveryResults")}
      description={t("pluginsPage.noDiscoveryResultsHint")}
    />
  );
}

function RawResults(props: CatalogResultsState): JSX.Element {
  const items = createMemo(() => props.result?.items ?? []);
  const official = createMemo(() => items().filter((plugin) => plugin.catalog.official));
  const community = createMemo(() => items().filter((plugin) => !plugin.catalog.official));
  return (
    <>
      {!props.connected ? (
        <p class="plugin-catalog-results__empty">{t("pluginsPage.discoveryOffline")}</p>
      ) : items().length === 0 ? (
        renderCatalogEmptyState()
      ) : (
        <>
          {props.query.trim() && official().length > 0 && community().length > 0 ? (
            <>
              <CatalogSection
                id="official"
                title={t("pluginsPage.official")}
                items={official()}
                state={props}
              />
              <CatalogSection
                id="community"
                title={t("pluginsPage.community")}
                items={community()}
                state={props}
              />
            </>
          ) : (
            <PluginCatalogGrid items={items()} results>
              {(plugin, contentRef) => (
                <CatalogCard plugin={plugin()} state={props} contentRef={contentRef} />
              )}
            </PluginCatalogGrid>
          )}
          <LoadMore {...props} />
        </>
      )}
    </>
  );
}

function GroupedCatalog(props: CatalogResultsState & { loading?: boolean }): JSX.Element {
  const items = createMemo(() => props.result?.items ?? []);
  const sourceCategories = createMemo(() => props.categories);
  const categories = createMemo(() =>
    sourceCategories()
      .filter((category) => category.slug !== "other")
      .toSorted((left, right) => left.order - right.order),
  );
  const hasCategoryItems = createMemo(() =>
    items().some((plugin) =>
      categories().some((category) => plugin.catalog.categories.includes(category.slug)),
    ),
  );
  const hasAnySection = () =>
    props.featured.length > 0 || props.trending.length > 0 || hasCategoryItems();
  return (
    <>
      {!hasAnySection() && !props.loading && !props.error && !props.remoteError ? (
        renderCatalogEmptyState()
      ) : (
        <>
          <For each={PROMOTED_SECTIONS}>
            {([intent, label]) => (
              <CatalogSection
                id={intent}
                title={t(label)}
                items={props[intent]}
                loading={props.loading}
                onViewAll={() => props.onIntentChange(intent)}
                state={props}
              />
            )}
          </For>
          <For each={categories()} keyed={(category) => category.slug}>
            {(category) => (
              <CatalogSection
                id={category().slug}
                title={category().label}
                items={items()
                  .filter((plugin) => plugin.catalog.categories.includes(category().slug))
                  .toSorted((left, right) =>
                    comparePluginCatalogEntries(left, right, category().slug),
                  )}
                onViewAll={() => props.onCategoryChange(category().slug)}
                state={props}
              />
            )}
          </For>
        </>
      )}
    </>
  );
}

export function renderPluginCatalogResults(props: PluginCatalogResultsProps): JSX.Element {
  const inventory = createMemo(() => props.inventory);
  const installedByCatalogId = createMemo(() => {
    const entries = new Map<string, PluginCatalogItem>();
    // Inventory order decides which installed copy supplies a catalog entry's state.
    for (const plugin of inventory() ?? []) {
      const catalogId = plugin.catalogId;
      if (plugin.installed && catalogId !== undefined && !entries.has(catalogId)) {
        entries.set(catalogId, plugin);
      }
    }
    return entries;
  });
  const recordedError = createMemo(() => props.error);
  const { ready, receipt } = createCatalogRead(() => props.reads.browse, recordedError);
  const resultAvailable = createMemo(() => props.result !== null);
  const query = createMemo(() => props.query.trim());
  const intent = createMemo(() => props.intent);
  const category = createMemo(() => props.category);
  const connected = createMemo(() => props.connected);
  const grouped = () => !query() && intent() === "all" && category() === null;
  // Publisher headers must not repeat the virtualizer's scroll compensation.
  const windowed = () => !grouped() && (props.result?.items.length ?? 0) > 60;
  const readCatalog = () => {
    // Same-selection refreshes must not hold live installation state or card controls.
    if (props.hasCurrentResult) {
      latest(ready);
    } else {
      ready();
    }
    return null;
  };
  let input!: HTMLInputElement;
  onSettled(() => {
    input.dataset.autofocused = "true";
    input.focus();
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (input.isConnected) {
          input.focus();
        }
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  });
  return (
    <section class="plugin-catalog-results" aria-label={t("pluginsPage.exploreTitle")}>
      <CatalogDiscoverySearch>
        <input
          type="search"
          class="oc-input"
          autofocus
          aria-label={t("pluginsPage.searchPlugins")}
          placeholder={t("pluginsPage.searchPlugins")}
          value={props.query}
          ref={(element) => (input = element)}
          onInput={(event) => props.onQueryChange(event.currentTarget.value)}
        />
      </CatalogDiscoverySearch>
      {/* First results enter below the settled categories; later reads keep their own boundaries. */}
      <Reveal collapsed>
        <CategoryChips {...props} />
        {props.remoteError ? renderError(props.remoteError, props.onRetry, true) : undefined}
        <Loading
          on={[
            query(),
            intent(),
            category(),
            connected(),
            recordedError(),
            resultAvailable() ? null : receipt().promise,
          ]}
          fallback={
            <div
              class="plugin-catalog-results__body"
              style={{ "overflow-anchor": windowed() ? "none" : undefined }}
            >
              {grouped() ? (
                <GroupedCatalog
                  {...props}
                  installedByCatalogId={installedByCatalogId()}
                  loading={true}
                />
              ) : (
                <PluginCatalogSkeleton label={t("pluginsPage.loadingDiscovery")} />
              )}
            </div>
          }
        >
          <div
            class="plugin-catalog-results__body"
            style={{ "overflow-anchor": windowed() ? "none" : undefined }}
          >
            <Errored
              fallback={(error, reset) =>
                renderError(formatUiError(error()), () => {
                  props.onRetry();
                  reset();
                })
              }
            >
              {readCatalog()}
            </Errored>
            {grouped() ? (
              <GroupedCatalog {...props} installedByCatalogId={installedByCatalogId()} />
            ) : props.hasCurrentResult || !recordedError() ? (
              <RawResults {...props} installedByCatalogId={installedByCatalogId()} />
            ) : undefined}
          </div>
        </Loading>
      </Reveal>
    </section>
  );
}
