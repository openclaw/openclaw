import type {
  SkillsWorkshopListResult,
  SkillWorkshopChange,
  SkillWorkshopSkillSummary,
} from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import { renderAgentScopeControl } from "../../components/agent-scope-control.ts";
import { icons } from "../../components/icons.ts";
import {
  renderSettingsEmpty,
  renderSettingsLoadingSkeleton,
  renderSettingsPage,
  renderSettingsSegmented,
} from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { registerSkillWorkshopEnglish } from "../../i18n/locales/en-skill-workshop.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import "../../styles/chat/text.css";
import "../../styles/plugins.css";
import "../../styles/skill-workshop.css";
import { renderPluginsHubHeader } from "../plugins/plugins-hub-header.ts";
import { PLUGINS_HUB_PANEL_ID } from "../plugins/plugins-hub.ts";
import { undoMutationFor, type WorkshopSnapshot } from "./api.ts";
import { renderDetail } from "./detail.ts";
import type { SkillWorkshopMode } from "./mode.ts";
import {
  lastActivityMs,
  latestChanges,
  renderMutationButton,
  renderUses,
  UNUSED_ARCHIVE_DAYS,
  unusedDays,
  type SkillWorkshopViewProps,
  type WorkshopFilter,
  type WorkshopSort,
} from "./view-shared.ts";

export type {
  WorkshopFilter,
  WorkshopSort,
  WorkshopTab,
  WorkshopViewer,
  WorkshopViewerTarget,
} from "./view-shared.ts";

registerSkillWorkshopEnglish();

const MODES: readonly SkillWorkshopMode[] = ["off", "auto"];
const SORTS: readonly WorkshopSort[] = ["uses", "recent", "name"];
export function sortWorkshopSkills(
  skills: readonly SkillWorkshopSkillSummary[],
  changes: readonly SkillWorkshopChange[],
  sort: WorkshopSort,
): SkillWorkshopSkillSummary[] {
  const latest = latestChanges(changes);
  const recent = (skill: SkillWorkshopSkillSummary) =>
    lastActivityMs(skill, latest.get(skill.name));
  return skills.toSorted((a, b) =>
    sort === "name"
      ? a.name.localeCompare(b.name)
      : sort === "recent"
        ? recent(b) - recent(a)
        : (b.useCount ?? 0) - (a.useCount ?? 0) ||
          recent(b) - recent(a) ||
          a.name.localeCompare(b.name),
  );
}

export function archivedWorkshopSkills(list: SkillsWorkshopListResult) {
  return list.archived
    .filter((skill) => !skill.live && skill.versions.length > 0)
    .toSorted((a, b) => (b.versions[0]?.createdAtMs ?? 0) - (a.versions[0]?.createdAtMs ?? 0));
}

export function renderSkillWorkshop(props: SkillWorkshopViewProps) {
  const { context, snapshot } = props;
  return html`
    ${renderPluginsHubHeader({
      active: "skill-workshop",
      onSelect: (tab) => context.navigate(tab),
    })}
    ${renderSettingsWorkspace(html`<wa-tab-panel
      id=${PLUGINS_HUB_PANEL_ID}
      name="skill-workshop"
      active
      aria-labelledby="plugins-tab-skill-workshop"
    >
      ${renderSettingsPage(
        html`
          ${renderToolbar(props)}
          ${[props.learningError, props.modeError, props.actionError].map((message) =>
            message ? renderError(message) : nothing,
          )}
          ${props.error ? renderError(`${t("skillWorkshop.loadError")} ${props.error}`, props.onRetry) : nothing}
          ${
            snapshot
              ? renderLibrary(snapshot, props)
              : props.loading
                ? renderSettingsLoadingSkeleton({ carapace: true })
                : nothing
          }
        `,
        { wide: true, carapace: true },
      )}
    </wa-tab-panel>`)}
  `;
}

function renderError(message: string, onRetry?: () => void) {
  return html`<div class="callout danger oc-banner oc-banner-error" role="alert">
    <span>${message}</span>
    ${
      onRetry
        ? html`<button
            type="button"
            class="btn btn--sm oc-action oc-action-secondary oc-banner-action"
            @click=${onRetry}
          >
            ${t("skillWorkshop.retry")}
          </button>`
        : nothing
    }
  </div>`;
}

/** Agent, Learning switch, and "learn from history" share one compact bar above the library. */
function renderToolbar(props: SkillWorkshopViewProps) {
  const { mode, learningAccess, context } = props;
  const agentScope = renderAgentScopeControl({
    agents: context.agents.state.agentsList?.agents ?? [],
    selection: context.agentSelection,
    selectedId: props.agentId,
    allowAll: false,
  });
  return html`<div class="sw-toolbar">
    <div class="sw-toolbar__start">${agentScope}</div>
    <div class="sw-toolbar__end">
      ${
        mode
          ? html`<div class="sw-learning" title=${t(`skillWorkshop.mode.${mode}Title`)}>
              <span class="sw-learning__label">
                <span class="sw-learning__dot sw-learning__dot--${mode}" aria-hidden="true"></span>
                ${t("skillWorkshop.mode.label")}
              </span>
              ${renderSettingsSegmented<SkillWorkshopMode>({
                mode: "buttons",
                ariaLabel: t("skillWorkshop.mode.aria"),
                value: mode,
                disabled: props.modeBusy || !props.access.canSetMode,
                options: MODES.map((value) => ({ value, label: t(`skillWorkshop.mode.${value}`) })),
                onChange: props.onModeChange,
              })}
            </div>`
          : nothing
      }
      <button
        type="button"
        class="btn btn--sm oc-action"
        title=${learningAccess.allowed ? t("skillWorkshop.learning.description") : learningAccess.reason}
        ?disabled=${props.learningBusy || !learningAccess.allowed}
        @click=${props.onLearn}
      >
        <span aria-hidden="true">${icons.wandSparkles}</span>
        ${props.learningBusy ? t("skillWorkshop.learning.starting") : t("skillWorkshop.learning.short")}
      </button>
    </div>
  </div>`;
}

function renderLibrary(snapshot: WorkshopSnapshot, props: SkillWorkshopViewProps) {
  const { list } = snapshot;
  const archived = archivedWorkshopSkills(list);
  if (list.skills.length === 0 && archived.length === 0) {
    return html`<div class="sw-empty oc-settings-group settings-group">
      <span class="sw-empty__icon" aria-hidden="true">${icons.wandSparkles}</span>
      <p>${t("skillWorkshop.skills.empty")}</p>
    </div>`;
  }
  return html`<div class="sw-layout">
    <section
      class="sw-list settings-group oc-settings-group"
      aria-label=${t("skillWorkshop.skills.title")}
    >
      <div class="sw-list__head">
        ${renderSettingsSegmented<WorkshopFilter>({
          mode: "buttons",
          ariaLabel: t("skillWorkshop.skills.filterAria"),
          value: props.filter,
          options: [
            {
              value: "active",
              label: html`${t("skillWorkshop.skills.active")}
                <span class="settings-count">${list.skills.length}</span>`,
            },
            {
              value: "archived",
              label: html`${t("skillWorkshop.skills.archived")}
                <span class="settings-count">${archived.length}</span>`,
            },
          ],
          onChange: props.onFilter,
        })}
        ${
          props.filter === "active"
            ? html`<label class="sw-sort">
                <span class="sr-only">${t("skillWorkshop.sort.label")}</span>
                <select
                  class="settings-select"
                  aria-label=${t("skillWorkshop.sort.label")}
                  @change=${(event: Event) => {
                    const select = event.currentTarget;
                    const sort = SORTS.find(
                      (entry) => select instanceof HTMLSelectElement && entry === select.value,
                    );
                    if (sort) {
                      props.onSort(sort);
                    }
                  }}
                >
                  ${SORTS.map(
                    (sort) =>
                      html`<option value=${sort} ?selected=${sort === props.sort}>
                        ${t(`skillWorkshop.sort.${sort}`)}
                      </option>`,
                  )}
                </select>
              </label>`
            : nothing
        }
      </div>
      <div class="sw-list__rows">
        ${
          props.filter === "active"
            ? list.skills.length === 0
              ? renderSettingsEmpty(t("skillWorkshop.skills.noneActive"), { carapace: true })
              : sortWorkshopSkills(list.skills, snapshot.changes, props.sort).map((skill) =>
                  renderSkillRow(skill, snapshot, props),
                )
            : archived.length === 0
              ? renderSettingsEmpty(t("skillWorkshop.skills.noneArchived"), { carapace: true })
              : archived.map((skill) => renderArchivedRow(skill, props))
        }
      </div>
    </section>
    <section class="sw-detail settings-group oc-settings-group">
      ${
        props.viewer
          ? renderDetail(props.viewer, snapshot, props)
          : renderSettingsEmpty(t("skillWorkshop.viewer.pick"), { carapace: true })
      }
    </section>
  </div>`;
}

function renderSkillRow(
  skill: SkillWorkshopSkillSummary,
  snapshot: WorkshopSnapshot,
  props: SkillWorkshopViewProps,
) {
  const selected = props.viewer?.target.name === skill.name;
  const change = latestChanges(snapshot.changes).get(skill.name);
  const unused = unusedDays(skill, change, props.mode);
  const undo = change ? undoMutationFor(change, snapshot.list) : null;
  return html`<div class="sw-row ${selected ? "sw-row--selected" : ""}">
    <button
      type="button"
      class="sw-row__main"
      aria-current=${selected ? "true" : nothing}
      @click=${() => props.onSelectSkill(skill.name)}
    >
      <span class="sw-row__top">
        <span class="sw-row__name">${skill.name}</span>
        ${
          unused !== null
            ? html`<span
                class="sw-badge sw-badge--warning"
                title=${t("skillWorkshop.unused.title", { days: String(UNUSED_ARCHIVE_DAYS) })}
                >${t("skillWorkshop.unused.badge", { days: String(unused) })}</span
              >`
            : html`<span class="sw-row__uses">${renderUses(skill.useCount)}</span>`
        }
      </span>
      ${skill.description ? html`<span class="sw-row__desc">${skill.description}</span>` : nothing}
    </button>
    ${
      change
        ? html`<div class="sw-row__change">
            <span class="sw-row__change-text">
              <span class="sw-row__change-who"
                >${t(`skillWorkshop.changes.actors.${change.actor}`)}
                ${t(`skillWorkshop.changes.actions.${change.action}`)}</span
              >
              ${change.summary ? html`<span class="sw-row__change-why">${change.summary}</span>` : nothing}
              <span class="sw-row__change-when"
                >${formatRelativeTimestamp(change.createdAtMs)}</span
              >
            </span>
            ${
              undo
                ? renderMutationButton(props, {
                    label: t("skillWorkshop.changes.undo"),
                    title: t("skillWorkshop.changes.undoTitle", { name: change.skillName }),
                    mutation: undo,
                    key: `undo:${change.id}`,
                    variant: "link",
                  })
                : nothing
            }
          </div>`
        : nothing
    }
  </div>`;
}

function renderArchivedRow(
  skill: SkillsWorkshopListResult["archived"][number],
  props: SkillWorkshopViewProps,
) {
  const selected = props.viewer?.target.name === skill.name;
  const latest = skill.versions[0];
  return html`<div class="sw-row ${selected ? "sw-row--selected" : ""}">
    <button
      type="button"
      class="sw-row__main"
      aria-current=${selected ? "true" : nothing}
      @click=${() => props.onSelectSkill(skill.name)}
    >
      <span class="sw-row__name">${skill.name}</span>
      ${
        latest
          ? html`<span class="sw-row__desc"
              >${t("skillWorkshop.skills.archivedAgo", {
                time: formatRelativeTimestamp(latest.createdAtMs),
              })}</span
            >`
          : nothing
      }
    </button>
  </div>`;
}
