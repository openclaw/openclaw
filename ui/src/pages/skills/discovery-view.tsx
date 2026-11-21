import { createMemo, createSignal, Errored, For, isPending, Loading, Show } from "solid-js";
import type { SkillLibraryEntry } from "../../../../packages/gateway-protocol/src/index.ts";
import type { SkillStatusEntry } from "../../api/types.ts";
import {
  CatalogDiscoveryChip,
  CatalogDiscoveryChips,
  CatalogDiscoverySection,
  CatalogDiscoverySearch,
} from "../../components/solid/catalog-discovery.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { registryCategoryIcon } from "../../components/solid/registry-category-icon.tsx";
import { SettingsEmpty, SettingsGroup } from "../../components/solid/settings-ui.tsx";
import { registerSkillsBrowserEnglish } from "../../i18n/locales/en-skills-browser.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { ClawHubSearchResult } from "../../lib/skills/clawhub-search.ts";
import { PluginCatalogGrid } from "../plugins/catalog-grid.tsx";
import { renderCatalogGridSkeleton } from "../plugins/catalog-skeleton.tsx";
import { PluginCardSummary, renderPluginOfficialBadge } from "../plugins/plugin-card.tsx";
import {
  SkillTile,
  installedReference,
  SkillStateStatus,
  verdictForSkill,
} from "./skill-status.tsx";
import "../../styles/skills-discovery.css";
import type { SkillsPresentation, SkillsProps } from "./view-types.ts";

registerSkillsBrowserEnglish();

type SkillDiscoveryEntry = {
  id: string;
  name: string;
  description: string;
  attribution: string;
  /** What the row shows after the name: the publisher handle when there is one. */
  byline: string;
  skill?: SkillStatusEntry;
  library?: SkillLibraryEntry;
  remote?: ClawHubSearchResult;
};

type SkillCategory = NonNullable<SkillsPresentation["clawhubCategory"]>;
const OVERVIEW_PREVIEW_SIZE = 4;

/** A shelf previews this page in feed order. Its action starts a separate category browse. */
function groupOverview(rows: SkillDiscoveryEntry[], taxonomy: SkillCategory[]) {
  if (!taxonomy.length || !rows.length) {
    return { shelves: [], ungrouped: rows };
  }
  const buckets = new Map<string, { category: SkillCategory; rows: SkillDiscoveryEntry[] }>();
  for (const category of taxonomy) {
    buckets.set(category.slug, { category, rows: [] });
  }
  const ungrouped: SkillDiscoveryEntry[] = [];
  for (const row of rows) {
    let matched = false;
    for (const slug of new Set(row.remote?.categories)) {
      const bucket = buckets.get(slug);
      if (bucket) {
        matched = true;
        if (bucket.rows.length < OVERVIEW_PREVIEW_SIZE) {
          bucket.rows.push(row);
        }
      }
    }
    if (!matched) {
      ungrouped.push(row);
    }
  }
  return { shelves: [...buckets.values()].filter((bucket) => bucket.rows.length), ungrouped };
}

function linkedOwner(skill: SkillStatusEntry): string | null {
  const link = skill.clawhub;
  return link?.valid && link.ownerHandle ? `@${link.ownerHandle}` : null;
}

function DiscoveryRow(props: {
  entry: SkillDiscoveryEntry;
  skills: SkillsProps;
  contentRef?: (element: HTMLDivElement) => void;
}) {
  const reference = () => props.entry.remote?.installRef ?? "";
  const installed = () => Boolean(props.entry.skill || props.entry.library);
  const icon = () => {
    const remote = props.entry.remote;
    return remote?.icon ? props.skills.state.clawhubIconUrls?.[remote.icon] : undefined;
  };
  const busy = () => {
    const operation = props.skills.state.skillOperation;
    return operation?.kind === "clawhub" && operation.ref === reference();
  };
  return (
    <article class="plugin-catalog-card plugin-catalog-row" data-skill-id={props.entry.id}>
      {(installed() || !props.entry.remote?.installOnly) && (
        <button
          type="button"
          class="plugin-catalog-card__primary-link skill-discovery-card__open"
          aria-label={t("skillsPage.openDetails", { name: props.entry.name })}
          onClick={() => {
            const entry = props.entry;
            if (entry.library) {
              props.skills.onLibraryOpen?.(entry.library.skillId);
            } else if (entry.skill) {
              props.skills.onDetailOpen(entry.skill.skillKey);
            } else {
              props.skills.onClawHubDetailOpen(reference());
            }
          }}
        />
      )}
      <div class="plugin-catalog-card__content" ref={(element) => props.contentRef?.(element)}>
        <div class="plugin-catalog-row__main">
          <SkillTile imageUrl={icon()} emoji={props.entry.skill?.emoji} />
          <div class="plugin-catalog-row__text">
            <div class="plugin-card-title-row">
              <h3>{props.entry.name}</h3>
              {props.entry.remote?.official ? renderPluginOfficialBadge() : undefined}
              <span class="plugin-card-author">{props.entry.byline}</span>
            </div>
            <PluginCardSummary summary={props.entry.description} />
            {props.entry.remote?.trustState && (
              <span class="muted skill-discovery-card__notice">
                {t("skillsPage.notScannedByClawHub")}
              </span>
            )}
          </div>
          <div class="plugin-catalog-card__action">
            {installed() ? (
              <SkillStateStatus
                skill={props.entry.skill ?? { disabled: !props.entry.library!.enabled }}
                verdict={
                  props.entry.skill
                    ? verdictForSkill(props.entry.skill, props.skills.state.clawhubVerdicts)
                    : null
                }
              />
            ) : (
              <button
                type="button"
                class="btn btn--sm plugin-catalog-card__install oc-action oc-action-secondary"
                disabled={
                  props.skills.saving ||
                  !props.skills.state.connected ||
                  !props.skills.canInstall ||
                  props.skills.loading ||
                  props.skills.state.skillOperation !== null
                }
                aria-label={t("skillsPage.addNamed", { name: props.entry.name })}
                onClick={() => props.skills.onClawHubInstall(reference())}
              >
                {t(busy() ? "skillsPage.adding" : "skillsPage.add")}
              </button>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

/** Installed skills in one line: their marks, the section name and the first names. */
function InstalledShelf(props: { entries: SkillDiscoveryEntry[]; onOpen: () => void }) {
  const marked = createMemo(() =>
    props.entries.toSorted(
      (left, right) => Number(Boolean(right.skill?.emoji)) - Number(Boolean(left.skill?.emoji)),
    ),
  );
  return (
    <button type="button" class="skill-installed-shelf" onClick={() => props.onOpen()}>
      <span class="skill-installed-shelf__stack" aria-hidden="true">
        <For each={marked().slice(0, 5)} keyed={(entry) => entry.id}>
          {(entry) => <SkillTile emoji={entry().skill?.emoji} />}
        </For>
      </span>
      <span class="skill-installed-shelf__text">
        <strong>{t("skillGroups.installed")}</strong>
        <span class="skill-installed-shelf__names">
          {props.entries
            .slice(0, 12)
            .map((entry) => entry.name)
            .join(", ")}
        </span>
      </span>
      <span class="skill-installed-shelf__chevron" aria-hidden="true">
        <Icon name="chevronRight" />
      </span>
    </button>
  );
}

export function SkillDiscovery(props: SkillsProps) {
  const query = createMemo(() => props.state.clawhubSearchQuery);
  const connected = createMemo(() => props.state.connected);
  const epoch = createMemo(() => props.clawhubSearchEpoch);
  const pending = createMemo(() => isPending(props.readClawHubSearch), { loadingValue: true });
  const [scope, setScope] = createSignal<"all" | "installed">("all");
  const category = createMemo(() => props.state.clawhubCategory);
  const catalog = createMemo(() => {
    const skills = props.mutationSkills;
    const libraries = props.libraryEntries ?? [];
    const results = props.state.clawhubSearchResults ?? [];
    const items: SkillDiscoveryEntry[] = libraries
      .filter((entry) => !entry.removed)
      .map((library) => ({
        id: `library:${library.skillId}`,
        name: library.slug,
        description: library.description,
        attribution: library.ownerLabel,
        byline: library.ownerLabel,
        library,
        skill: skills.find(
          (skill) => skill.source === "openclaw-library" && skill.name === library.name,
        ),
      }));
    const libraryCommands = new Set(libraries.map((entry) => entry.name));
    for (const skill of skills) {
      // Library command names are persisted identities, unlike user-facing names/slugs.
      if (skill.source === "openclaw-library" && libraryCommands.has(skill.name)) {
        continue;
      }
      items.push({
        id: `local:${skill.skillKey}`,
        name: skill.name,
        description: skill.description,
        attribution: installedReference(skill) ?? skill.source,
        byline: linkedOwner(skill) ?? installedReference(skill) ?? skill.source,
        skill,
      });
    }
    const remoteRows: SkillDiscoveryEntry[] = [];
    const remoteIds = new Set<string>();
    for (const remote of results) {
      const reference = remote.installRef;
      const identity = `${remote.registry}\n${reference}`;
      if (remoteIds.has(identity)) {
        continue;
      }
      remoteIds.add(identity);
      // A name match is never installation proof. Match the registry and verified publisher/source.
      const installed = items.find(
        (entry) =>
          entry.skill?.clawhub?.valid &&
          entry.skill.clawhub.registry === remote.registry &&
          installedReference(entry.skill) === reference,
      );
      if (installed) {
        installed.remote = remote;
        remoteRows.push(installed);
      } else {
        remoteRows.push({
          id: `remote:${reference}`,
          name: remote.displayName,
          description: remote.summary ?? "",
          attribution: reference,
          byline: remote.ownerHandle ? `@${remote.ownerHandle}` : reference,
          remote,
        });
      }
    }
    return { installed: items, remote: remoteRows };
  });
  const installed = createMemo(() => {
    // Canonical-form comparison: a composed (NFC) query must match decomposed (NFD) copy.
    const filter = props.state.clawhubSearchQuery.trim().toLowerCase().normalize("NFC");
    // Remote matches retain the registry's semantic ranking, even if their copy lacks the query.
    return catalog().installed.filter(
      (entry) =>
        entry.remote ||
        !filter ||
        `${entry.name} ${entry.description} ${entry.attribution}`
          .toLowerCase()
          .normalize("NFC")
          .includes(filter),
    );
  });
  const hasInstalled = createMemo(() => catalog().installed.length > 0);
  // During a search, installed matches that ClawHub also returned stay in the registry's ranking.
  const installedRows = createMemo(() =>
    scope() === "installed" ? installed() : installed().filter((entry) => !entry.remote),
  );
  const installedSection = createMemo(() =>
    !category() && (scope() === "installed" || query().trim()) ? installedRows() : [],
  );
  const remoteRows = createMemo(() => (scope() === "all" ? catalog().remote : []));
  const shelf = () => scope() === "all" && !category() && !query().trim() && installed().length > 0;
  const selectBuiltin = (next: "all" | "installed") => {
    setScope(next);
    props.onCategoryChange(null);
  };
  const categoryChips = new Map<string, HTMLButtonElement>();
  const selectCategory = (next: SkillCategory) => {
    setScope("all");
    props.onCategoryChange(next);
  };
  const sections = createMemo(() => {
    if (category() || query().trim() || scope() !== "all") {
      return { shelves: [], ungrouped: remoteRows() };
    }
    // An unavailable directory is empty; a pending directory has not placed any rows yet.
    const directory = props.readCategories();
    return directory && groupOverview(remoteRows(), directory.categories);
  });
  const remoteTitle = () => category()?.label ?? t("skillsPage.clawHub");
  const inventoryReady = () =>
    props.libraryEntries !== undefined &&
    !props.loading &&
    (!props.error || props.state.skillsReport);
  return (
    <section
      class="plugin-catalog-results plugin-catalog-results--rows skill-discovery"
      aria-label={t("skillsPage.title")}
    >
      <CatalogDiscoverySearch>
        <input
          type="search"
          class="settings-input"
          name="skills-search"
          autocomplete="off"
          aria-label={t("skillDiscovery.search")}
          placeholder={t("skillDiscovery.search")}
          value={props.state.clawhubSearchQuery}
          onInput={(event) => props.onClawHubQueryChange(event.currentTarget.value)}
        />
      </CatalogDiscoverySearch>
      {props.error && (
        <InlineAlert tone="danger" role="alert">
          {props.error}
        </InlineAlert>
      )}
      {!props.state.connected && (
        <p role="status" class="muted">
          {t("skillsPage.disconnected")}
        </p>
      )}
      <Errored
        fallback={(error, reset) => (
          <Loading fallback={null}>
            <Show when={!isPending(props.readClawHubSearch)}>
              <InlineAlert tone="danger" role="alert">
                {formatUiError(error())}{" "}
                <button
                  type="button"
                  class="btn btn--sm"
                  onClick={() => {
                    if (props.hasNextPage) {
                      props.onLoadMore();
                    } else {
                      props.onClawHubQueryChange(query());
                    }
                    reset();
                  }}
                >
                  {t("common.retry")}
                </button>
              </InlineAlert>
            </Show>
          </Loading>
        )}
      >
        <Loading on={[query(), category(), connected(), epoch()]} fallback={null}>
          {props.readClawHubSearch() && null}
        </Loading>
      </Errored>
      {props.state.clawhubInstallMessage && (
        <InlineAlert
          tone={props.state.clawhubInstallMessage!.kind === "error" ? "danger" : "success"}
        >
          {props.state.clawhubInstallMessage!.text}
        </InlineAlert>
      )}
      {/* The registry sets the number of chips; one row keeps installed skills in place. */}
      <CatalogDiscoveryChips label={t("skillsPage.categories")} singleRow>
        <CatalogDiscoveryChip
          fixed
          icon={<Icon name="layoutGrid" />}
          active={scope() === "all" && !category()}
          onClick={() => selectBuiltin("all")}
        >
          {t("skillsPage.tabs.all")}
        </CatalogDiscoveryChip>
        <Show when={hasInstalled()}>
          <CatalogDiscoveryChip
            fixed
            icon={<Icon name="bookOpenText" />}
            active={scope() === "installed"}
            onClick={() => selectBuiltin("installed")}
          >
            {t("skillsPage.installed")}
          </CatalogDiscoveryChip>
        </Show>
        <Show when={props.readCategories()?.error}>
          {(message) => (
            <InlineAlert tone="warning" role="alert">
              {message()}{" "}
              <button type="button" class="btn btn--sm" onClick={() => props.onRetryCategories()}>
                {t("common.retry")}
              </button>
            </InlineAlert>
          )}
        </Show>
        <Show
          when={props.readCategories()}
          fallback={
            <span
              class="skeleton plugin-catalog-chip--skeleton"
              style={{ height: "auto" }}
              aria-hidden="true"
            />
          }
        >
          {(directory) => (
            <For each={directory().categories} keyed={(item) => item.slug}>
              {(item) => (
                <CatalogDiscoveryChip
                  fixed
                  ref={(button) => categoryChips.set(item().slug, button)}
                  icon={registryCategoryIcon(item().icon)}
                  active={category()?.slug === item().slug}
                  onClick={() => selectCategory(item())}
                >
                  {item().label}
                </CatalogDiscoveryChip>
              )}
            </For>
          )}
        </Show>
      </CatalogDiscoveryChips>
      <div class="plugin-catalog-results__body">
        <Show when={shelf()}>
          <InstalledShelf entries={installed()} onOpen={() => setScope("installed")} />
        </Show>
        <Show when={installedSection().length > 0}>
          <CatalogDiscoverySection id="installed" title={t("skillGroups.installed")}>
            <PluginCatalogGrid items={installedSection()} results busy={props.loading}>
              {(entry, contentRef) => (
                <DiscoveryRow entry={entry()} skills={props} contentRef={contentRef} />
              )}
            </PluginCatalogGrid>
          </CatalogDiscoverySection>
        </Show>
        <Show
          when={remoteRows().length > 0 && sections()}
          fallback={
            <Show
              when={
                scope() === "all" &&
                (pending() || (remoteRows().length > 0 && !sections())) &&
                props.state.connected
              }
            >
              <CatalogDiscoverySection id="clawhub" title={remoteTitle()}>
                {renderCatalogGridSkeleton({ label: t("skillsPage.searching"), cards: 6 })}
              </CatalogDiscoverySection>
            </Show>
          }
        >
          <For each={sections()?.shelves} keyed={(section) => section.category.slug}>
            {(section) => (
              <CatalogDiscoverySection
                id={"category-" + section().category.slug}
                title={section().category.label}
                viewAllLabel={t("skillsPage.viewAll")}
                // Previews have at most four rows; the next section must not paint below a provisional shelf.
                eager
                onViewAll={() => {
                  // The shelf button leaves the DOM; keep keyboard navigation on its matching chip.
                  const next = section().category;
                  categoryChips.get(next.slug)?.focus();
                  selectCategory(next);
                }}
              >
                <div class="plugin-catalog-grid">
                  <For each={section().rows} keyed={(entry) => entry.id}>
                    {(entry) => <DiscoveryRow entry={entry()} skills={props} />}
                  </For>
                </div>
              </CatalogDiscoverySection>
            )}
          </For>
          <Show when={sections()?.ungrouped.length}>
            <CatalogDiscoverySection id="clawhub" title={remoteTitle()}>
              <PluginCatalogGrid
                items={sections()?.ungrouped ?? []}
                results
                busy={props.loading || pending()}
              >
                {(entry, contentRef) => (
                  <DiscoveryRow entry={entry()} skills={props} contentRef={contentRef} />
                )}
              </PluginCatalogGrid>
            </CatalogDiscoverySection>
          </Show>
        </Show>
        <Show when={scope() === "all" && props.hasNextPage && sections()}>
          <div class="plugin-catalog-load-more">
            <button
              type="button"
              class="btn btn--sm oc-action oc-action-secondary"
              disabled={pending()}
              onClick={() => props.onLoadMore()}
            >
              {t(pending() ? "skillsPage.loadingMore" : "skillsPage.loadMore")}
            </button>
          </div>
        </Show>
      </div>
      <Errored fallback={() => null}>
        <Loading on={[query(), category(), connected(), epoch()]} fallback={null}>
          {props.readClawHubSearch() &&
            (category() || inventoryReady()) &&
            !props.hasNextPage &&
            installedSection().length + remoteRows().length === 0 &&
            !shelf() &&
            props.state.connected && (
              <SettingsGroup>
                <SettingsEmpty
                  message={
                    <span role="status">
                      {t(
                        category()
                          ? "skillsPage.noFilteredSkills"
                          : query().trim()
                            ? "skillsPage.noMatches"
                            : "skillsPage.empty",
                      )}
                    </span>
                  }
                />
              </SettingsGroup>
            )}
        </Loading>
      </Errored>
    </section>
  );
}
