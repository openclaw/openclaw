import type {
  SkillsWorkshopListResult,
  SkillsWorkshopReadResult,
  SkillWorkshopChange,
} from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import { renderAgentScopeControl } from "../../components/agent-scope-control.ts";
import { icons } from "../../components/icons.ts";
import {
  renderSettingsEmpty,
  renderSettingsGroup,
  renderSettingsLoadingSkeleton,
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsSegmented,
  renderSettingsStatus,
} from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { registerSkillWorkshopEnglish } from "../../i18n/locales/en-skill-workshop.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import type { SessionMethodAccess } from "../../lib/session-method-access.ts";
import "../../styles/plugins.css";
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
  const { context, snapshot } = props;
  const agentScope = renderAgentScopeControl({
    agents: context.agents.state.agentsList?.agents ?? [],
    selection: context.agentSelection,
    selectedId: props.agentId,
    allowAll: false,
  });
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
          ${agentScope === nothing ? nothing : html`<div class="plugins-toolbar">${agentScope}</div>`}
          ${renderLearning(props)}
          ${[props.learningError, props.modeError, props.actionError].map((message) =>
            message ? renderError(message) : nothing,
          )}
          ${props.error ? renderError(`${t("skillWorkshop.loadError")} ${props.error}`, props.onRetry) : nothing}
          ${
            snapshot
              ? renderLibrary(snapshot, props)
              : props.loading
                ? renderSettingsSection(
                    { title: t("skillWorkshop.skills.title"), carapace: true },
                    renderSettingsLoadingSkeleton({ carapace: true }),
                  )
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

function renderLearning(props: SkillWorkshopViewProps) {
  const { mode, learningAccess } = props;
  return renderSettingsGroup(
    html`
      ${
        mode
          ? renderSettingsRow({
              carapace: true,
              title: t("skillWorkshop.mode.label"),
              description: t(`skillWorkshop.mode.${mode}Title`),
              control: renderSettingsSegmented<SkillWorkshopMode>({
                mode: "buttons",
                ariaLabel: t("skillWorkshop.mode.aria"),
                value: mode,
                disabled: props.modeBusy || !props.access.canSetMode,
                options: MODES.map((value) => ({ value, label: t(`skillWorkshop.mode.${value}`) })),
                onChange: props.onModeChange,
              }),
            })
          : nothing
      }
      ${renderSettingsRow({
        carapace: true,
        title: t("skillWorkshop.learning.title"),
        description: t("skillWorkshop.learning.description"),
        control: html`<button
          type="button"
          class="btn oc-action"
          aria-label=${t("skillWorkshop.learning.title")}
          ?disabled=${props.learningBusy || !learningAccess.allowed}
          title=${learningAccess.allowed ? nothing : learningAccess.reason}
          @click=${props.onLearn}
        >
          <span aria-hidden="true">${icons.wandSparkles}</span>
          ${props.learningBusy ? t("skillWorkshop.learning.starting") : t("skillWorkshop.learning.action")}
        </button>`,
      })}
    `,
    { carapace: true },
  );
}

function renderLibrary(snapshot: WorkshopSnapshot, props: SkillWorkshopViewProps) {
  const { list } = snapshot;
  const archived = list.archived.filter((skill) => !skill.live);
  const empty = list.skills.length === 0 && archived.length === 0;
  return html`<div class="sw-layout">
    <div class="settings-stack">
      ${renderSettingsSection(
        { title: t("skillWorkshop.skills.title"), count: list.skills.length, carapace: true },
        list.skills.length === 0
          ? renderSettingsEmpty(t("skillWorkshop.skills.empty"), { carapace: true })
          : list.skills.map((skill) =>
              renderSkillRow(props, {
                name: skill.name,
                description: skill.description,
                meta: html`${t("skillWorkshop.skills.updated", {
                  time: formatRelativeTimestamp(skill.updatedAtMs),
                })}${
                  skill.useCount
                    ? html` ·
                      ${
                        skill.useCount === 1
                          ? t("skillWorkshop.skills.usesOne")
                          : t("skillWorkshop.skills.uses", { count: String(skill.useCount) })
                      }`
                    : nothing
                }`,
              }),
            ),
      )}
      ${archived.length > 0 ? renderArchived(archived, props) : nothing}
      ${renderSettingsSection(
        { title: t("skillWorkshop.changes.title"), carapace: true },
        snapshot.changes.length === 0
          ? renderSettingsEmpty(t("skillWorkshop.changes.empty"))
          : snapshot.changes.map((change) => renderChangeRow(change, list, props)),
      )}
    </div>
    ${
      empty && !props.viewer
        ? nothing
        : html`<div class="sw-viewer">
            ${renderSettingsSection(
              { title: t("skillWorkshop.viewer.title"), carapace: true },
              props.viewer
                ? renderViewer(props.viewer, list, props)
                : renderSettingsEmpty(t("skillWorkshop.viewer.pick")),
            )}
          </div>`
    }
  </div>`;
}

function renderSkillRow(
  props: SkillWorkshopViewProps,
  skill: { name: string; description?: string; meta: unknown },
  control: unknown = nothing,
) {
  const selected = props.viewer?.target.name === skill.name;
  return html`<div
    class="settings-row oc-settings-row plugins-item plugins-item--clickable ${
      selected ? "sw-selected" : ""
    }"
  >
    <button
      type="button"
      class="settings-row__text oc-settings-row-content plugins-item__detail-button"
      aria-current=${selected ? "true" : nothing}
      @click=${() => props.onSelectSkill(skill.name)}
    >
      <span class="settings-row__title oc-settings-row-title">${skill.name}</span>
      ${
        skill.description
          ? html`<span class="settings-row__desc oc-settings-row-description"
              >${skill.description}</span
            >`
          : nothing
      }
      <span class="sw-meta">${skill.meta}</span>
    </button>
    ${
      control === nothing
        ? nothing
        : html`<div class="settings-row__control oc-settings-row-control">${control}</div>`
    }
  </div>`;
}

function renderArchived(
  archived: SkillsWorkshopListResult["archived"],
  props: SkillWorkshopViewProps,
) {
  return html`<details class="settings-section oc-settings-section skills-group">
    <summary class="settings-section__header oc-settings-section-header skills-group__summary">
      <h2 class="settings-section__heading oc-settings-section-title">
        ${t("skillWorkshop.skills.archived")}
        <span class="settings-count">${archived.length}</span>
      </h2>
      <span class="skills-group__chevron" aria-hidden="true">${icons.chevronRight}</span>
    </summary>
    ${renderSettingsGroup(
      archived.map((skill) => {
        const latest = skill.versions[0];
        return renderSkillRow(
          props,
          {
            name: skill.name,
            meta: latest
              ? `${formatRelativeTimestamp(latest.createdAtMs)} · ${t(
                  `skillWorkshop.changes.actions.${latest.action}`,
                )}`
              : nothing,
          },
          renderMutationButton(props, {
            label: t("skillWorkshop.viewer.restore"),
            mutation: { method: "skills.workshop.restore", name: skill.name },
            key: `restore:${skill.name}`,
          }),
        );
      }),
      { carapace: true },
    )}
  </details>`;
}

function renderChangeRow(
  change: SkillWorkshopChange,
  list: SkillsWorkshopListResult,
  props: SkillWorkshopViewProps,
) {
  const undo = undoMutationFor(change, list);
  return renderSettingsRow({
    carapace: true,
    title: html`<button
      type="button"
      class="sw-link"
      @click=${() => props.onSelectSkill(change.skillName)}
    >
      ${change.skillName}
    </button>`,
    description: html`${change.summary}<span class="sw-meta"
        >${t(`skillWorkshop.changes.actors.${change.actor}`)}
        ${t(`skillWorkshop.changes.actions.${change.action}`)} ·
        ${formatRelativeTimestamp(change.createdAtMs)}</span
      >`,
    control: undo
      ? renderMutationButton(props, {
          label: t("skillWorkshop.changes.undo"),
          title: t("skillWorkshop.changes.undoTitle", { name: change.skillName }),
          mutation: undo,
          key: `undo:${change.id}`,
        })
      : nothing,
  });
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
    class="btn btn--sm oc-action"
    title=${params.title ?? nothing}
    ?disabled=${props.pendingAction !== null}
    @click=${() => props.onMutate(params.mutation, params.key)}
  >
    ${props.pendingAction === params.key ? t("skillWorkshop.viewer.loading") : params.label}
  </button>`;
}

function renderViewer(
  viewer: WorkshopViewer,
  list: SkillsWorkshopListResult,
  props: SkillWorkshopViewProps,
) {
  const { target } = viewer;
  const live = list.skills.some((skill) => skill.name === target.name);
  const versions = list.archived.find((skill) => skill.name === target.name)?.versions ?? [];
  const files = viewer.status === "ready" ? viewer.result.files : [target.filePath];
  return html`
    ${renderSettingsRow({
      carapace: true,
      title: target.name,
      description: live ? nothing : t("skillWorkshop.viewer.archivedNotice"),
      control:
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
            : nothing,
    })}
    <div class="settings-row oc-settings-row sw-viewer__fields">
      <label class="plugins-field">
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
          ? html`<label class="plugins-field">
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
        ? renderSettingsEmpty(t("skillWorkshop.viewer.loading"))
        : viewer.status === "error"
          ? renderSettingsRow({
              carapace: true,
              role: "alert",
              title: renderSettingsStatus({ kind: "danger", label: viewer.error, carapace: true }),
            })
          : html`<pre class="sw-file">${viewer.result.content}</pre>`
    }
  `;
}
