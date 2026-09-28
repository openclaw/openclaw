import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { html, nothing } from "lit";
import type { SkillStatusEntry, SkillStatusReport } from "../../api/types.ts";
import {
  renderSettingsEmpty,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsToggle,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { resolveAgentConfig, resolveAgentSkillsFilter } from "../../lib/agents/display.ts";
import { groupSkills, type SkillGroup } from "../../lib/skills-grouping.ts";
import {
  computeSkillMissing,
  computeSkillReasons,
  renderSkillStatusChips,
} from "../../lib/skills-shared.ts";

registerSettingsEnglish();

export function renderAgentSkills(params: {
  agentId: string;
  report: SkillStatusReport | null;
  loading: boolean;
  error: string | null;
  activeAgentId: string | null;
  configForm: Record<string, unknown> | null;
  configLoading: boolean;
  configSaving: boolean;
  configDirty: boolean;
  filter: string;
  canPatchConfig: boolean;
  canUpdateConfig: boolean;
  onFilterChange: (next: string) => void;
  onRefresh: () => void;
  onToggle: (agentId: string, skillName: string, enabled: boolean) => void;
  onClear: (agentId: string) => void;
  onDisableAll: (agentId: string) => void;
  onConfigReload: () => void;
  onConfigSave: () => void;
}) {
  const editable =
    params.canUpdateConfig &&
    Boolean(params.configForm) &&
    !params.configLoading &&
    !params.configSaving;
  const config = resolveAgentConfig(params.configForm, params.agentId);
  const explicitAllowlist = Array.isArray(config.entry?.skills)
    ? normalizeStringEntries(config.entry.skills)
    : undefined;
  const allowlist = resolveAgentSkillsFilter(params.configForm, params.agentId);
  const allowSet = new Set(allowlist ?? []);
  const usingAllowlist = allowlist !== undefined;
  const inheritedAllowlist = explicitAllowlist === undefined && usingAllowlist;
  const canClear =
    params.canPatchConfig &&
    explicitAllowlist !== undefined &&
    Boolean(params.configForm) &&
    !params.configLoading &&
    !params.configSaving;
  const reportReady = Boolean(params.report && params.activeAgentId === params.agentId);
  const rawSkills = reportReady ? (params.report?.skills ?? []) : [];
  const filter = normalizeLowercaseStringOrEmpty(params.filter);
  const filtered = filter
    ? rawSkills.filter((skill) =>
        normalizeLowercaseStringOrEmpty(
          [skill.name, skill.description, skill.source].join(" "),
        ).includes(filter),
      )
    : rawSkills;
  const groups = groupSkills(filtered);
  const enabledCount = usingAllowlist
    ? rawSkills.filter((skill) => allowSet.has(skill.name)).length
    : rawSkills.length;
  const totalCount = rawSkills.length;

  return html`
    ${
      !params.configForm
        ? html`<div class="callout info">${t("agents.skillsPanel.loadConfig")}</div>`
        : nothing
    }
    ${
      usingAllowlist
        ? html`<div class="callout info">
            ${t(
              inheritedAllowlist
                ? "agents.skillsPanel.inheritedAllowlist"
                : "agents.skillsPanel.customAllowlist",
            )}
          </div>`
        : html`<div class="callout info">${t("agents.skillsPanel.allEnabled")}</div>`
    }
    ${
      !reportReady && !params.loading
        ? html`<div class="callout info">${t("agents.skillsPanel.loadAgent")}</div>`
        : nothing
    }
    ${params.error ? html`<div class="callout danger">${params.error}</div>` : nothing}
    ${renderSettingsSection(
      {
        title: t("agents.skillsPanel.title"),
        description: html`${t("agents.skillsPanel.subtitle")}
        ${totalCount > 0 ? html`<span class="mono">${enabledCount}/${totalCount}</span>` : nothing}`,
        actions: html`
          <button
            class="btn btn--sm"
            ?disabled=${!editable}
            @click=${() => params.onDisableAll(params.agentId)}
          >
            ${t("agentTools.disableAll")}
          </button>
          <button
            class="btn btn--sm"
            ?disabled=${!canClear}
            @click=${() => params.onClear(params.agentId)}
          >
            ${t("common.reset")}
          </button>
          <button
            class="btn btn--sm"
            ?disabled=${params.configLoading}
            @click=${params.onConfigReload}
          >
            ${t("common.reloadConfig")}
          </button>
          <button class="btn btn--sm" ?disabled=${params.loading} @click=${params.onRefresh}>
            ${params.loading ? t("common.loading") : t("common.refresh")}
          </button>
          <button
            class="btn btn--sm primary"
            ?disabled=${!params.canUpdateConfig || params.configSaving || !params.configDirty}
            @click=${params.onConfigSave}
          >
            ${params.configSaving ? t("common.saving") : t("common.save")}
          </button>
        `,
      },
      html`
        ${renderSettingsRow({
          title: t("agents.skillsPanel.filter"),
          description: t("agents.skillsPanel.shown", { count: String(filtered.length) }),
          control: html`
            <input
              class="settings-input"
              aria-label=${t("agents.skillsPanel.filter")}
              .value=${params.filter}
              @input=${(event: Event) => {
                const input = event.currentTarget;
                if (input instanceof HTMLInputElement) {
                  params.onFilterChange(input.value);
                }
              }}
              placeholder=${t("agents.skillsPanel.searchPlaceholder")}
              autocomplete="off"
              name="agent-skills-filter"
            />
          `,
        })}
        ${
          filtered.length === 0
            ? renderSettingsEmpty(t("agents.skillsPanel.empty"))
            : html`
                <div class="agents-panel-body agent-skills-groups">
                  ${groups.map((group) =>
                    renderAgentSkillGroup(group, {
                      agentId: params.agentId,
                      allowSet,
                      usingAllowlist,
                      editable,
                      filterActive: Boolean(filter),
                      onToggle: params.onToggle,
                    }),
                  )}
                </div>
              `
        }
      `,
    )}
  `;
}

function renderAgentSkillGroup(
  group: SkillGroup,
  params: {
    agentId: string;
    allowSet: Set<string>;
    usingAllowlist: boolean;
    editable: boolean;
    filterActive: boolean;
    onToggle: (agentId: string, skillName: string, enabled: boolean) => void;
  },
) {
  const collapsedByDefault =
    !params.filterActive && (group.id === "workspace" || group.id === "built-in");
  return html`
    <details class="agent-skills-group" ?open=${!collapsedByDefault}>
      <summary class="agent-skills-header">
        <span>${group.label}</span>
        <span class="muted">${group.skills.length}</span>
      </summary>
      <div class="list skills-grid">
        ${group.skills.map((skill) =>
          renderAgentSkillRow(skill, {
            agentId: params.agentId,
            allowSet: params.allowSet,
            usingAllowlist: params.usingAllowlist,
            editable: params.editable,
            onToggle: params.onToggle,
          }),
        )}
      </div>
    </details>
  `;
}

function renderAgentSkillRow(
  skill: SkillStatusEntry,
  params: {
    agentId: string;
    allowSet: Set<string>;
    usingAllowlist: boolean;
    editable: boolean;
    onToggle: (agentId: string, skillName: string, enabled: boolean) => void;
  },
) {
  const enabled = params.usingAllowlist ? params.allowSet.has(skill.name) : true;
  const missing = computeSkillMissing(skill);
  const reasons = computeSkillReasons(skill);
  return html`
    <div class="settings-row agent-skill-row">
      <div class="settings-row__text">
        <span class="settings-row__title"
          >${skill.emoji ? `${skill.emoji} ` : ""}${skill.name}</span
        >
        <span class="settings-row__desc">${skill.description}</span>
        ${renderSkillStatusChips({ skill })}
        ${
          missing.length > 0
            ? html`<span class="settings-row__desc">
                ${t("agents.skillsPanel.missing", { items: missing.join(", ") })}
              </span>`
            : nothing
        }
        ${
          reasons.length > 0
            ? html`<span class="settings-row__desc">
                ${t("agents.skillsPanel.reason", { items: reasons.join(", ") })}
              </span>`
            : nothing
        }
      </div>
      <div class="settings-row__control">
        ${renderSettingsToggle({
          checked: enabled,
          disabled: !params.editable,
          ariaLabel: skill.name,
          onChange: (checked) => params.onToggle(params.agentId, skill.name, checked),
        })}
      </div>
    </div>
  `;
}
