import { createMemo, Errored, For, isPending, Loading, Show } from "solid-js";
import type { SkillLibraryEntry } from "../../../../packages/gateway-protocol/src/index.ts";
import type { SkillStatusEntry } from "../../api/types.ts";
import {
  CatalogDiscoverySearch,
  CatalogDiscoverySection,
  CatalogDiscoveryChips,
  CatalogDiscoveryChip,
} from "../../components/solid/catalog-discovery.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { SettingsEmpty, SettingsGroup } from "../../components/solid/settings-ui.tsx";
import { registerSkillsBrowserEnglish } from "../../i18n/locales/en-skills-browser.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { handleNavigationClick } from "../../lib/navigation-click.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { ClawHubSearchResult } from "../../lib/skills/clawhub-search.ts";
import { PluginCatalogGrid } from "../plugins/catalog-grid.tsx";
import { PluginCardSummary, renderPluginOfficialBadge } from "../plugins/plugin-card.tsx";
import { skillCatalogSections, type SkillCatalogTarget } from "./catalog-location.ts";
import "../../styles/skills-discovery.css";
import { SkillStateStatus, verdictForSkill } from "./skill-status.tsx";
import type { SkillsProps } from "./view-types.ts";

registerSkillsBrowserEnglish();

type SkillDiscoveryEntry = {
  id: string;
  name: string;
  description: string;
  attribution: string;
  skill?: SkillStatusEntry;
  library?: SkillLibraryEntry;
  remote?: ClawHubSearchResult;
  rank?: number;
};

function installedReference(skill: SkillStatusEntry): string | null {
  const link = skill.clawhub;
  if (!link?.valid) {
    return null;
  }
  return link.requestedReference ?? (link.ownerHandle ? `@${link.ownerHandle}/${link.slug}` : null);
}

function DiscoveryCard(props: {
  entry: SkillDiscoveryEntry;
  skills: SkillsProps;
  contentRef: (element: HTMLDivElement) => void;
}) {
  const reference = () => props.entry.remote?.installRef ?? "";
  const target = (): SkillCatalogTarget =>
    props.entry.library
      ? { kind: "library", key: props.entry.library.skillId }
      : props.entry.skill
        ? { kind: "local", key: props.entry.skill.skillKey }
        : { kind: "remote", key: reference() };
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
    <article class="plugin-catalog-card oc-card oc-card-interactive" data-skill-id={props.entry.id}>
      {(installed() || !props.entry.remote?.installOnly) && (
        <a
          href={props.skills.catalogHref(target())}
          class="plugin-catalog-card__primary-link skill-discovery-card__open"
          aria-label={t("skillsPage.openDetails", { name: props.entry.name })}
          onClick={(event) =>
            handleNavigationClick(event, () => props.skills.onCatalogOpen(target()))
          }
        />
      )}
      <div class="plugin-catalog-card__content" ref={props.contentRef}>
        <div class="plugin-catalog-card__head">
          <div class="installed-plugins-card__head">
            <span class="installed-plugins-card__art plugin-catalog-card__art" aria-hidden="true">
              {icon() ? (
                <img src={icon()} alt="" loading="lazy" />
              ) : (
                (props.entry.skill?.emoji ?? <Icon name="bookOpenText" />)
              )}
            </span>
            <div class="installed-plugins-card__identity">
              <div class="plugin-card-title-row">
                <h3>{props.entry.name}</h3>
                {props.entry.remote?.official === true && renderPluginOfficialBadge()}
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
                      aria-label={t("skillsPage.installNamed", { name: props.entry.name })}
                      onClick={() => props.skills.onClawHubInstall(reference())}
                    >
                      {t(busy() ? "skillsPage.installing" : "skillsPage.install")}
                    </button>
                  )}
                </div>
              </div>
              <span class="plugin-card-author">{props.entry.attribution}</span>
            </div>
          </div>
        </div>
        <PluginCardSummary summary={props.entry.description} />
        {props.entry.remote?.trustState && (
          <span class="muted skill-discovery-card__notice">
            {t("skillsPage.notScannedByClawHub")}
          </span>
        )}
      </div>
    </article>
  );
}

export function SkillDiscovery(props: SkillsProps) {
  const query = createMemo(() => props.state.clawhubSearchQuery);
  const connected = createMemo(() => props.state.connected);
  const epoch = createMemo(() => props.clawhubSearchEpoch);
  const pending = createMemo(() => isPending(props.readClawHubSearch), { loadingValue: true });
  const entries = createMemo<SkillDiscoveryEntry[]>(() => {
    const skills = props.mutationSkills;
    const libraries = props.libraryEntries ?? [];
    const results = props.state.clawhubSearchResults ?? [];
    const queryValue = props.state.clawhubSearchQuery;
    const items: SkillDiscoveryEntry[] = libraries
      .filter((entry) => !entry.removed)
      .map((library) => ({
        id: `library:${library.skillId}`,
        name: library.slug,
        description: library.description,
        attribution: library.ownerLabel,
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
        skill,
      });
    }
    const remoteIds = new Set<string>();
    for (const [rank, remote] of results.entries()) {
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
        installed.rank = rank;
      } else {
        items.push({
          id: `remote:${reference}`,
          name: remote.displayName,
          description: remote.summary ?? "",
          attribution: reference,
          remote,
          rank,
        });
      }
    }
    // Canonical-form comparison: a composed (NFC) query must match decomposed (NFD) copy.
    const filter = queryValue.trim().toLowerCase().normalize("NFC");
    // Remote matches retain the registry's semantic ranking, even if their copy lacks the query.
    return items.filter(
      (entry) =>
        entry.remote ||
        !filter ||
        `${entry.name} ${entry.description} ${entry.attribution}`
          .toLowerCase()
          .normalize("NFC")
          .includes(filter),
    );
  });
  const sections = createMemo(() => ({
    trending: entries()
      .filter((entry) => entry.remote)
      .toSorted((left, right) => left.rank! - right.rank!),
    installed: entries().filter((entry) => entry.skill && !entry.library),
    library: entries().filter((entry) => entry.library),
  }));
  const selectedEntries = createMemo(() =>
    props.catalogSection === "all"
      ? [...entries().filter((entry) => !entry.remote), ...sections().trending]
      : sections()[props.catalogSection],
  );
  const searchGroups = createMemo(() => {
    if (!query().trim() || props.catalogSection !== "all") return [];
    const remote = sections().trending;
    const official = remote.filter((entry) => entry.remote?.official === true);
    const community = remote.filter((entry) => entry.remote?.official === false);
    if (!official.length || !community.length) return [];
    // Registry status is explicit; an unclassified entry is not proof of a community publisher.
    return [
      {
        id: "installed",
        title: t("skillsPage.installed"),
        items: entries().filter((entry) => !entry.remote),
      },
      { id: "official", title: t("pluginsPage.official"), items: official },
      { id: "community", title: t("pluginsPage.community"), items: community },
      {
        id: "registry",
        title: t("skillsPage.clawHub"),
        items: remote.filter((entry) => entry.remote?.official === undefined),
      },
    ].filter((section) => section.items.length);
  });
  const grouped = () => !query().trim() && props.catalogSection === "all";
  const labels = {
    all: "skillsPage.tabs.all",
    trending: "pluginsPage.intentTrending",
    installed: "skillsPage.installed",
    library: "skillLibrary.library",
  } as const;
  const icons = {
    all: "layoutGrid",
    trending: "barChart",
    installed: "check",
    library: "bookOpenText",
  } as const;
  function Grid(grid: { items: SkillDiscoveryEntry[] }) {
    return (
      <PluginCatalogGrid items={grid.items} results={!grouped()} busy={props.loading || pending()}>
        {(entry, contentRef) => (
          <DiscoveryCard entry={entry()} skills={props} contentRef={contentRef} />
        )}
      </PluginCatalogGrid>
    );
  }
  return (
    <section class="plugin-catalog-results skill-discovery" aria-label={t("skillsPage.title")}>
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
      <CatalogDiscoveryChips label={t("skillsPage.title")}>
        <For each={skillCatalogSections}>
          {(section) => (
            <CatalogDiscoveryChip
              active={props.catalogSection === section}
              onClick={() => props.onCatalogSectionChange(section)}
              icon={<Icon name={icons[section]} />}
            >
              {t(labels[section])}
            </CatalogDiscoveryChip>
          )}
        </For>
      </CatalogDiscoveryChips>
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
                    props.onClawHubQueryChange(query());
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
        <Loading on={[query(), connected(), epoch()]} fallback={null}>
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
      <div class="plugin-catalog-results__body">
        <Show
          when={grouped() && entries().length}
          fallback={
            <Show when={searchGroups().length} fallback={<Grid items={selectedEntries()} />}>
              <For each={searchGroups()} keyed={(section) => section.id}>
                {(section) => (
                  <CatalogDiscoverySection id={section().id} title={section().title}>
                    <Grid items={section().items} />
                  </CatalogDiscoverySection>
                )}
              </For>
            </Show>
          }
        >
          <For each={["trending", "library", "installed"] as const}>
            {(section) => (
              <Show when={sections()[section].length}>
                <CatalogDiscoverySection
                  id={section}
                  title={t(labels[section])}
                  viewAllLabel={t("pluginsPage.viewAllInstalledPlugins")}
                  onViewAll={() => props.onCatalogSectionChange(section)}
                >
                  <Grid items={sections()[section].slice(0, 8)} />
                </CatalogDiscoverySection>
              </Show>
            )}
          </For>
        </Show>
      </div>
      <Errored fallback={() => null}>
        <Loading on={[query(), connected(), epoch()]} fallback={null}>
          {props.readClawHubSearch() &&
            props.libraryEntries !== undefined &&
            selectedEntries().length === 0 &&
            !props.loading &&
            (!props.error || props.state.skillsReport) &&
            props.state.connected && (
              <SettingsGroup>
                <SettingsEmpty
                  message={
                    <span role="status">
                      {t(
                        query().trim() || props.catalogSection !== "all"
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
