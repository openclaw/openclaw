import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { resolveSafeExternalUrl } from "../../lib/open-external-url.ts";
import { clawHubSkillRef } from "../../lib/skills/clawhub-search.ts";
import { renderPluginCardSummary } from "../plugins/plugin-card.ts";
import { skillDiscoveryEntries, type SkillDiscoveryEntry } from "./discovery.ts";
import { renderSkillStateStatus, verdictForSkill } from "./skill-status.ts";
import type { SkillsProps } from "./view-types.ts";
import "../../styles/skills-discovery.css";

function renderCard(entry: SkillDiscoveryEntry, props: SkillsProps) {
  const remote = entry.remote;
  const reference = remote ? clawHubSkillRef(remote) : "";
  const installed = Boolean(entry.skill || entry.library);
  const canOpen = installed || !remote?.installOnly;
  const icon = remote?.icon ? resolveSafeExternalUrl(remote.icon, window.location.href) : null;
  const busy = props.operation?.kind === "clawhub" && props.operation.ref === reference;
  return html`<article
    class="plugin-catalog-card oc-card oc-card-interactive"
    data-skill-id=${entry.id}
  >
    ${
      canOpen
        ? html`<button
            type="button"
            class="plugin-catalog-card__primary-link skill-discovery-card__open"
            aria-label=${t("skillsPage.openDetails", { name: entry.name })}
            @click=${() => (entry.library ? props.onLibraryOpen?.(entry.library.skillId) : entry.skill ? props.onDetailOpen(entry.skill.skillKey) : props.onClawHubDetailOpen(reference))}
          ></button>`
        : nothing
    }
    <div class="plugin-catalog-card__head">
      <div class="installed-plugins-card__head">
        <span class="installed-plugins-card__art plugin-catalog-card__art" aria-hidden="true">
          ${icon ? html`<img src=${icon} alt="" loading="lazy" />` : (entry.skill?.emoji ?? icons.zap)}
        </span>
        <div class="installed-plugins-card__identity">
          <div class="plugin-card-title-row"><h3>${entry.name}</h3></div>
          <span class="plugin-card-author">${entry.attribution}</span>
        </div>
      </div>
      <div class="plugin-catalog-card__action">
        ${
          installed
            ? renderSkillStateStatus(
                entry.skill ?? { disabled: !entry.library!.enabled },
                entry.skill ? verdictForSkill(entry.skill, props.clawhubVerdicts) : null,
              )
            : html`<button
                type="button"
                class="btn btn--sm plugin-catalog-card__install oc-action oc-action-secondary"
                ?disabled=${!props.connected || !props.canInstall || props.loading || props.operation !== null}
                aria-label=${t("skillsPage.installNamed", { name: entry.name })}
                @click=${() => props.onClawHubInstall(reference)}
              >
                ${t(busy ? "skillsPage.installing" : "skillsPage.install")}
              </button>`
        }
      </div>
    </div>
    ${renderPluginCardSummary(entry.description)}
    ${remote?.trustState ? html`<span class="muted skill-discovery-card__notice">${t("skillsPage.notScannedByClawHub")}</span>` : nothing}
  </article>`;
}

export function renderSkillDiscovery(props: SkillsProps) {
  const entries = skillDiscoveryEntries({
    skills: props.report?.skills ?? [],
    libraries: props.libraryEntries ?? [],
    results: props.clawhubResults ?? [],
    query: props.clawhubQuery,
  });
  return html`<section
    class="plugin-catalog-results skill-discovery"
    aria-label=${t("skillsPage.title")}
  >
    <label class="plugin-catalog-search">
      <span aria-hidden="true">${icons.search}</span>
      <input
        type="search"
        class="settings-input"
        name="skills-search"
        autocomplete="off"
        autofocus
        aria-label=${t("skillDiscovery.search")}
        placeholder=${t("skillDiscovery.search")}
        .value=${props.clawhubQuery}
        @input=${(event: Event) => {
          // SAFETY: this listener is attached directly to the search input.
          props.onClawHubQueryChange((event.currentTarget as HTMLInputElement).value);
        }}
        ${ref((element) => {
          if (element instanceof HTMLInputElement && !element.dataset.autofocused) {
            element.dataset.autofocused = "true";
            queueMicrotask(() => {
              if (element.isConnected) {
                element.focus({ preventScroll: true });
              }
            });
          }
        })}
      />
    </label>
    ${props.error ? html`<div class="callout danger" role="alert">${props.error}</div>` : nothing}
    ${!props.connected ? html`<p role="status" class="muted">${t("skillsPage.disconnected")}</p>` : nothing}
    ${
      props.clawhubSearchError
        ? html`<div class="callout danger" role="alert">
            ${props.clawhubSearchError}
            <button
              type="button"
              class="btn btn--sm"
              @click=${() => props.onClawHubQueryChange(props.clawhubQuery)}
            >
              ${t("common.retry")}
            </button>
          </div>`
        : nothing
    }
    ${
      props.clawhubInstallMessage
        ? html`<div
            role=${props.clawhubInstallMessage.kind === "error" ? "alert" : "status"}
            class="callout ${props.clawhubInstallMessage.kind === "error" ? "danger" : "success"}"
          >
            ${props.clawhubInstallMessage.text}
          </div>`
        : nothing
    }
    <div
      class="plugin-catalog-grid plugin-catalog-grid--results"
      aria-busy=${props.loading || props.clawhubSearchLoading}
    >
      ${repeat(
        entries,
        (entry) => entry.id,
        (entry) => renderCard(entry, props),
      )}
    </div>
    ${
      entries.length === 0 &&
      !props.loading &&
      !props.clawhubSearchLoading &&
      props.connected &&
      !props.clawhubSearchError
        ? html`<p class="muted" role="status">${t("skillsPage.empty")}</p>`
        : nothing
    }
  </section>`;
}
