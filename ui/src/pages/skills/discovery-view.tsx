import { createMemo, Errored, For, isPending, Loading, onSettled, Show } from "solid-js";
import type { SkillLibraryEntry } from "../../../../packages/gateway-protocol/src/index.ts";
import type { SkillStatusEntry } from "../../api/types.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { registerSkillsBrowserEnglish } from "../../i18n/locales/en-skills-browser.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { ClawHubSearchResult } from "../../lib/skills/clawhub-search.ts";
import { PluginCardSummary } from "../plugins/plugin-card.tsx";
import { SkillStateStatus, verdictForSkill } from "./skill-status.tsx";
import type { SkillsProps } from "./view-types.ts";
import "../../styles/skills-discovery.css";

registerSkillsBrowserEnglish();

type SkillDiscoveryEntry = {
  id: string;
  name: string;
  description: string;
  attribution: string;
  skill?: SkillStatusEntry;
  library?: SkillLibraryEntry;
  remote?: ClawHubSearchResult;
};

function installedReference(skill: SkillStatusEntry): string | null {
  const link = skill.clawhub;
  if (!link?.valid) {
    return null;
  }
  return link.requestedReference ?? (link.ownerHandle ? `@${link.ownerHandle}/${link.slug}` : null);
}

function DiscoveryCard(props: { entry: SkillDiscoveryEntry; skills: SkillsProps }) {
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
    <article class="plugin-catalog-card oc-card oc-card-interactive" data-skill-id={props.entry.id}>
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
              <h2>{props.entry.name}</h2>
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
    </article>
  );
}

export function SkillDiscovery(props: SkillsProps) {
  const query = createMemo(() => props.state.clawhubSearchQuery);
  const connected = createMemo(() => props.state.connected);
  const epoch = createMemo(() => props.clawhubSearchEpoch);
  const pending = createMemo(() => isPending(props.readClawHubSearch), { loadingValue: true });
  let input: HTMLInputElement | undefined;
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
      } else {
        items.push({
          id: `remote:${reference}`,
          name: remote.displayName,
          description: remote.summary ?? "",
          attribution: reference,
          remote,
        });
      }
    }
    const filter = queryValue.trim().toLowerCase();
    // Remote matches retain the registry's semantic ranking, even if their copy lacks the query.
    return items.filter(
      (entry) =>
        entry.remote ||
        !filter ||
        `${entry.name} ${entry.description} ${entry.attribution}`.toLowerCase().includes(filter),
    );
  });
  onSettled(() => {
    if (input?.isConnected) {
      input.focus({ preventScroll: true });
    }
  });
  return (
    <section class="plugin-catalog-results skill-discovery" aria-label={t("skillsPage.title")}>
      <label class="plugin-catalog-search">
        <span aria-hidden="true">
          <Icon name="search" />
        </span>
        <input
          ref={(element) => {
            input = element;
          }}
          type="search"
          class="settings-input"
          name="skills-search"
          autocomplete="off"
          autofocus
          aria-label={t("skillDiscovery.search")}
          placeholder={t("skillDiscovery.search")}
          value={props.state.clawhubSearchQuery}
          onInput={(event) => props.onClawHubQueryChange(event.currentTarget.value)}
        />
      </label>
      {props.error && (
        <div class="callout danger" role="alert">
          {props.error}
        </div>
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
              <div class="callout danger" role="alert">
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
              </div>
            </Show>
          </Loading>
        )}
      >
        <Loading on={[query(), connected(), epoch()]} fallback={null}>
          {props.readClawHubSearch() && null}
        </Loading>
      </Errored>
      {props.state.clawhubInstallMessage && (
        <div
          role={props.state.clawhubInstallMessage!.kind === "error" ? "alert" : "status"}
          class={[
            "callout",
            {
              danger: props.state.clawhubInstallMessage!.kind === "error",
              success: props.state.clawhubInstallMessage!.kind !== "error",
            },
          ]}
        >
          {props.state.clawhubInstallMessage!.text}
        </div>
      )}
      <div
        class="plugin-catalog-grid plugin-catalog-grid--results"
        aria-busy={props.loading || pending() ? "true" : "false"}
      >
        <For each={entries()} keyed={(entry) => entry.id}>
          {(entry) => <DiscoveryCard entry={entry()} skills={props} />}
        </For>
      </div>
      <Errored fallback={() => null}>
        <Loading on={[query(), connected(), epoch()]} fallback={null}>
          {props.readClawHubSearch() &&
            entries().length === 0 &&
            !props.loading &&
            props.state.connected && (
              <p class="muted" role="status">
                {t("skillsPage.empty")}
              </p>
            )}
        </Loading>
      </Errored>
    </section>
  );
}
