import type {
  SkillsWorkshopListResult,
  SkillsWorkshopReadResult,
  SkillWorkshopChange,
  SkillWorkshopSkillSummary,
} from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import { renderAgentScopeControl } from "../../components/agent-scope-control.ts";
import { icons } from "../../components/icons.ts";
import { renderSettingsSegmented } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerSkillWorkshopEnglish } from "../../i18n/locales/en-skill-workshop.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import type { SessionMethodAccess } from "../../lib/session-method-access.ts";
import "../../styles/skill-workshop.css";
import { renderPluginsHubHeader } from "../plugins/plugins-hub-header.ts";
import { PLUGINS_HUB_PANEL_ID } from "../plugins/plugins-hub.ts";
import type { SkillWorkshopAccess } from "./access.ts";
import { undoMutationFor, type WorkshopMutation, type WorkshopSnapshot } from "./api.ts";
import type { SkillWorkshopMode } from "./mode.ts";

registerSkillWorkshopEnglish();

export type WorkshopViewerTarget = { name: string; filePath: string; versionId?: string };

export type WorkshopViewer =
  | { target: WorkshopViewerTarget; status: "loading" }
  | { target: WorkshopViewerTarget; status: "ready"; result: SkillsWorkshopReadResult }
  | { target: WorkshopViewerTarget; status: "error"; error: string };

type SkillWorkshopViewProps = {
  context: ApplicationContext;
  agentId: string | null;
  access: SkillWorkshopAccess;
  snapshot: WorkshopSnapshot | null;
  loading: boolean;
  error: string | null;
  viewer: WorkshopViewer | null;
  pendingAction: string | null;
  actionError: string | null;
  mode: SkillWorkshopMode | null;
  modeBusy: boolean;
  modeError: string | null;
  learningAccess: SessionMethodAccess;
  learningBusy: boolean;
  learningError: string | null;
  onRetry: () => void;
  onSelectSkill: (name: string) => void;
  onOpen: (target: WorkshopViewerTarget) => void;
  onMutate: (mutation: WorkshopMutation, key: string) => void;
  onModeChange: (mode: SkillWorkshopMode) => void;
  onLearn: () => void;
};

const MODES: readonly SkillWorkshopMode[] = ["off", "auto"];

export function renderSkillWorkshop(props: SkillWorkshopViewProps) {
  const { context, mode } = props;
  return html`
    <section class="content--skill-workshop">
      ${renderPluginsHubHeader({
        active: "skill-workshop",
        onSelect: (tab) => context.navigate(tab),
      })}
      <wa-tab-panel
        id=${PLUGINS_HUB_PANEL_ID}
        class="sw-hub-panel"
        name="skill-workshop"
        active
        aria-labelledby="plugins-tab-skill-workshop"
      >
        <div class="sw-toolbar">
          ${renderAgentScopeControl({
            agents: context.agents.state.agentsList?.agents ?? [],
            selection: context.agentSelection,
            selectedId: props.agentId,
            allowAll: false,
          })}
          ${
            mode
              ? html`<div class="sw-mode">
                  <span class="sw-mode__label">${t("skillWorkshop.mode.label")}</span>
                  ${renderSettingsSegmented<SkillWorkshopMode>({
                    mode: "buttons",
                    ariaLabel: t("skillWorkshop.mode.aria"),
                    value: mode,
                    disabled: props.modeBusy || !props.access.canSetMode,
                    options: MODES.map((value) => ({
                      value,
                      label: t(`skillWorkshop.mode.${value}`),
                      title: t(`skillWorkshop.mode.${value}Title`),
                    })),
                    onChange: props.onModeChange,
                  })}
                </div>`
              : nothing
          }
          <button
            type="button"
            class="btn sw-learn"
            ?disabled=${props.learningBusy || !props.learningAccess.allowed}
            title=${
              props.learningAccess.allowed
                ? t("skillWorkshop.learning.description")
                : props.learningAccess.reason
            }
            @click=${props.onLearn}
          >
            <span aria-hidden="true">${icons.wandSparkles}</span>
            ${props.learningBusy ? t("skillWorkshop.learning.starting") : t("skillWorkshop.learning.start")}
          </button>
        </div>
        ${[props.learningError, props.modeError, props.actionError].map((message) =>
          message ? html`<div class="sw-error" role="alert">${message}</div>` : nothing,
        )}
        ${
          props.error
            ? html`<div class="sw-error" role="alert">
                ${t("skillWorkshop.loadError")} ${props.error}
                <button type="button" class="btn btn--sm" @click=${props.onRetry}>
                  ${t("skillWorkshop.retry")}
                </button>
              </div>`
            : nothing
        }
        <div class="sw-layout">
          <div class="sw-column">${renderSkills(props)} ${renderChanges(props)}</div>
          ${renderViewer(props)}
        </div>
      </wa-tab-panel>
    </section>
  `;
}

function renderSkillRow(skill: SkillWorkshopSkillSummary, props: SkillWorkshopViewProps) {
  const uses = skill.useCount
    ? skill.useCount === 1
      ? t("skillWorkshop.skills.usesOne")
      : t("skillWorkshop.skills.uses", { count: String(skill.useCount) })
    : null;
  return html`<li>
    <button
      type="button"
      class="sw-skill"
      aria-current=${props.viewer?.target.name === skill.name ? "true" : nothing}
      @click=${() => props.onSelectSkill(skill.name)}
    >
      <span class="sw-skill__name">${skill.name}</span>
      <span class="sw-skill__desc">${skill.description}</span>
      <span class="sw-meta">
        ${t("skillWorkshop.skills.updated", { time: formatRelativeTimestamp(skill.updatedAtMs) })}
        ${uses ? html` · ${uses}` : nothing}
      </span>
    </button>
  </li>`;
}

function renderSkills(props: SkillWorkshopViewProps) {
  const list = props.snapshot?.list;
  const archived = list?.archived.filter((skill) => !skill.live) ?? [];
  return html`<section class="sw-panel" aria-labelledby="sw-skills-title">
    <h2 id="sw-skills-title" class="sw-panel__title">
      ${t("skillWorkshop.skills.title")}
      ${list ? html`<span class="settings-count">${list.skills.length}</span>` : nothing}
    </h2>
    ${
      !list
        ? props.loading
          ? html`<p class="sw-muted">${t("skillWorkshop.viewer.loading")}</p>`
          : nothing
        : list.skills.length === 0
          ? html`<p class="sw-muted">${t("skillWorkshop.skills.empty")}</p>`
          : html`<ul class="sw-list">
              ${list.skills.map((skill) => renderSkillRow(skill, props))}
            </ul>`
    }
    ${
      archived.length > 0
        ? html`<details class="sw-archived">
            <summary>
              ${t("skillWorkshop.skills.archived")}
              <span class="settings-count">${archived.length}</span>
            </summary>
            <ul class="sw-list">
              ${archived.map(
                (skill) => html`<li class="sw-archived__row">
                  <button
                    type="button"
                    class="sw-skill"
                    aria-current=${props.viewer?.target.name === skill.name ? "true" : nothing}
                    @click=${() => props.onSelectSkill(skill.name)}
                  >
                    <span class="sw-skill__name">${skill.name}</span>
                    ${
                      skill.versions[0]
                        ? html`<span class="sw-meta"
                            >${formatRelativeTimestamp(skill.versions[0].createdAtMs)}</span
                          >`
                        : nothing
                    }
                  </button>
                  ${renderMutationButton(props, {
                    label: t("skillWorkshop.viewer.restore"),
                    mutation: { method: "skills.workshop.restore", name: skill.name },
                    key: `restore:${skill.name}`,
                  })}
                </li>`,
              )}
            </ul>
          </details>`
        : nothing
    }
  </section>`;
}

function renderChangeRow(
  change: SkillWorkshopChange,
  list: SkillsWorkshopListResult,
  props: SkillWorkshopViewProps,
) {
  const undo = undoMutationFor(change, list);
  return html`<li class="sw-change">
    <div class="sw-change__line">
      <span class="sw-change__actor">${t(`skillWorkshop.changes.actors.${change.actor}`)}</span>
      ${t(`skillWorkshop.changes.actions.${change.action}`)}
      <button type="button" class="sw-link" @click=${() => props.onSelectSkill(change.skillName)}>
        ${change.skillName}
      </button>
      <span class="sw-meta">${formatRelativeTimestamp(change.createdAtMs)}</span>
    </div>
    ${change.summary ? html`<div class="sw-change__summary">${change.summary}</div>` : nothing}
    ${
      undo
        ? renderMutationButton(props, {
            label: t("skillWorkshop.changes.undo"),
            title: t("skillWorkshop.changes.undoTitle", { name: change.skillName }),
            mutation: undo,
            key: `undo:${change.id}`,
          })
        : nothing
    }
  </li>`;
}

function renderChanges(props: SkillWorkshopViewProps) {
  const changes = props.snapshot?.changes;
  const list = props.snapshot?.list;
  return html`<section class="sw-panel" aria-labelledby="sw-changes-title">
    <h2 id="sw-changes-title" class="sw-panel__title">${t("skillWorkshop.changes.title")}</h2>
    ${
      !changes || !list
        ? nothing
        : changes.length === 0
          ? html`<p class="sw-muted">${t("skillWorkshop.changes.empty")}</p>`
          : html`<ol class="sw-list sw-changes">
              ${changes.map((change) => renderChangeRow(change, list, props))}
            </ol>`
    }
  </section>`;
}

function renderMutationButton(
  props: SkillWorkshopViewProps,
  params: { label: string; title?: string; mutation: WorkshopMutation; key: string },
) {
  const allowed =
    params.mutation.method === "skills.workshop.archive"
      ? props.access.canArchive
      : props.access.canRestore;
  if (!allowed) {
    return nothing;
  }
  return html`<button
    type="button"
    class="btn btn--sm"
    title=${params.title ?? nothing}
    ?disabled=${props.pendingAction !== null}
    @click=${() => props.onMutate(params.mutation, params.key)}
  >
    ${props.pendingAction === params.key ? t("skillWorkshop.viewer.loading") : params.label}
  </button>`;
}

function renderViewer(props: SkillWorkshopViewProps) {
  const viewer = props.viewer;
  if (!viewer) {
    return html`<section class="sw-panel sw-viewer">
      <p class="sw-muted">${t("skillWorkshop.viewer.pick")}</p>
    </section>`;
  }
  const { target } = viewer;
  const list = props.snapshot?.list;
  const live = list?.skills.some((skill) => skill.name === target.name) ?? false;
  const versions = list?.archived.find((skill) => skill.name === target.name)?.versions ?? [];
  const files = viewer.status === "ready" ? viewer.result.files : [target.filePath];
  return html`<section class="sw-panel sw-viewer" aria-labelledby="sw-viewer-title">
    <div class="sw-viewer__header">
      <h2 id="sw-viewer-title" class="sw-panel__title">${target.name}</h2>
      ${
        live && !target.versionId
          ? renderMutationButton(props, {
              label: t("skillWorkshop.viewer.archive"),
              mutation: { method: "skills.workshop.archive", name: target.name },
              key: `archive:${target.name}`,
            })
          : target.versionId
            ? renderMutationButton(props, {
                label: t(
                  live ? "skillWorkshop.viewer.restoreVersion" : "skillWorkshop.viewer.restore",
                ),
                mutation: {
                  method: "skills.workshop.restore",
                  name: target.name,
                  versionId: target.versionId,
                },
                key: `restore:${target.name}:${target.versionId}`,
              })
            : nothing
      }
    </div>
    ${live ? nothing : html`<p class="sw-muted">${t("skillWorkshop.viewer.archivedNotice")}</p>`}
    <div class="sw-viewer__controls">
      <label class="field">
        <span>${t("skillWorkshop.viewer.file")}</span>
        <select
          class="settings-select"
          @change=${(event: Event) => {
            if (event.currentTarget instanceof HTMLSelectElement) {
              props.onOpen({ ...target, filePath: event.currentTarget.value });
            }
          }}
        >
          ${files.map(
            (file) =>
              html`<option value=${file} ?selected=${file === target.filePath}>${file}</option>`,
          )}
        </select>
      </label>
      ${
        versions.length > 0
          ? html`<label class="field">
              <span>${t("skillWorkshop.viewer.version")}</span>
              <select
                class="settings-select"
                @change=${(event: Event) => {
                  if (event.currentTarget instanceof HTMLSelectElement) {
                    props.onOpen({
                      name: target.name,
                      filePath: "SKILL.md",
                      versionId: event.currentTarget.value || undefined,
                    });
                  }
                }}
              >
                ${
                  live
                    ? html`<option value="" ?selected=${!target.versionId}>
                        ${t("skillWorkshop.viewer.current")}
                      </option>`
                    : nothing
                }
                ${versions.map(
                  (version) =>
                    html`<option value=${version.id} ?selected=${version.id === target.versionId}>
                      ${formatRelativeTimestamp(version.createdAtMs)} ·
                      ${t(`skillWorkshop.changes.actions.${version.action}`)}
                    </option>`,
                )}
              </select>
            </label>`
          : nothing
      }
    </div>
    ${
      viewer.status === "loading"
        ? html`<p class="sw-muted">${t("skillWorkshop.viewer.loading")}</p>`
        : viewer.status === "error"
          ? html`<div class="sw-error" role="alert">${viewer.error}</div>`
          : html`<pre class="sw-file">${viewer.result.content}</pre>`
    }
  </section>`;
}
