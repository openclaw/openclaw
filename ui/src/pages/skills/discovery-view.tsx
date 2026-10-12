import { createMemo, For, onSettled } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { registerSkillsBrowserEnglish } from "../../i18n/locales/en-skills-browser.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { PluginCardSummary } from "../plugins/plugin-card.tsx";
import { skillDiscoveryEntries, type SkillDiscoveryEntry } from "./discovery.ts";
import { SkillStateStatus, verdictForSkill } from "./skill-status.tsx";
import type { SkillsProps } from "./view-types.ts";
import "../../styles/skills-discovery.css";

registerSkillsBrowserEnglish();

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
            </div>
            <span class="plugin-card-author">{props.entry.attribution}</span>
          </div>
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
  let input: HTMLInputElement | undefined;
  const entries = createMemo(() =>
    skillDiscoveryEntries({
      skills: props.state.skillsReport?.skills ?? [],
      libraries: props.libraryEntries ?? [],
      results: props.state.clawhubSearchResults ?? [],
      query: props.state.clawhubSearchQuery,
    }),
  );
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
      {props.state.clawhubSearchError && (
        <div class="callout danger" role="alert">
          {props.state.clawhubSearchError}{" "}
          <button
            type="button"
            class="btn btn--sm"
            onClick={() => props.onClawHubQueryChange(props.state.clawhubSearchQuery)}
          >
            {t("common.retry")}
          </button>
        </div>
      )}
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
        aria-busy={props.loading || props.state.clawhubSearchLoading ? "true" : "false"}
      >
        <For each={entries()} keyed={(entry) => entry.id}>
          {(entry) => <DiscoveryCard entry={entry()} skills={props} />}
        </For>
      </div>
      {entries().length === 0 &&
        !props.loading &&
        !props.state.clawhubSearchLoading &&
        props.state.connected &&
        !props.state.clawhubSearchError && (
          <p class="muted" role="status">
            {t("skillsPage.empty")}
          </p>
        )}
    </section>
  );
}
