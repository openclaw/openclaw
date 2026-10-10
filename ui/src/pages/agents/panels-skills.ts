import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { html, nothing } from "lit";
import type { SkillStatusReport } from "../../api/types.ts";
import {
  renderSettingsEmpty,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsToggle,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { resolveAgentConfig, resolveAgentSkillsFilter } from "../../lib/agents/display.ts";
import { groupSkills } from "../../lib/skills-grouping.ts";
import {
  computeSkillMissing,
  computeSkillReasons,
  isWorkshopSkill,
  renderSkillStatusChips,
} from "../../lib/skills-shared.ts";
import { renderAgentConfigActions, type AgentConfigActions } from "./config-actions.ts";
import { renderAgentPanelAction } from "./panel-ui.ts";

registerSettingsEnglish();

export function renderAgentSkills(
  params: AgentConfigActions & {
    agentId: string;
    report: SkillStatusReport | null;
    loading: boolean;
    error: string | null;
    activeAgentId: string | null;
    configForm: Record<string, unknown> | null;
    filter: string;
    canPatchConfig: boolean;
    onFilterChange: (next: string) => void;
    onRefresh: () => void;
    onToggle: (agentId: string, skillName: string, enabled: boolean) => void;
    onClear: (agentId: string) => void;
    onDisableAll: (agentId: string) => void;
  },
) {
  const configReady = Boolean(params.configForm) && !params.configLoading && !params.configSaving;
  const editable = params.canUpdateConfig && configReady;
  const config = resolveAgentConfig(params.configForm, params.agentId);
  const hasExplicitAllowlist = Array.isArray(config.entry?.skills);
  const allowlist = resolveAgentSkillsFilter(params.configForm, params.agentId);
  const allowSet = new Set(allowlist ?? []);
  const usingAllowlist = allowlist !== undefined;
  const inheritedAllowlist = !hasExplicitAllowlist && usingAllowlist;
  const canClear = params.canPatchConfig && hasExplicitAllowlist && configReady;
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
    ? rawSkills.filter((skill) => isWorkshopSkill(skill) || allowSet.has(skill.name)).length
    : rawSkills.length;
  const totalCount = rawSkills.length;

  return html`
    ${
      !params.configForm
        ? html`<div class="callout info">${t("agents.skillsPanel.loadConfig")}</div>`
        : nothing
    }
    <div class="callout info">
      ${t(
        usingAllowlist
          ? inheritedAllowlist
            ? "agents.skillsPanel.inheritedAllowlist"
            : "agents.skillsPanel.customAllowlist"
          : "agents.skillsPanel.allEnabled",
      )}
    </div>
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
          ${renderAgentPanelAction(t("agentTools.disableAll"), !editable, () => params.onDisableAll(params.agentId))}
          ${renderAgentPanelAction(t("common.reset"), !canClear, () => params.onClear(params.agentId))}
          ${renderAgentConfigActions(
            params,
            html`
              ${renderAgentPanelAction(params.loading ? t("common.loading") : t("common.refresh"), params.loading, params.onRefresh)}
            `,
          )}
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
                  ${groups.map(
                    (group) => html`
                      <details
                        class="agent-skills-group"
                        ?open=${Boolean(filter) || (group.id !== "workspace" && group.id !== "built-in")}
                      >
                        <summary class="agent-skills-header">
                          <span>${group.label}</span>
                          <span class="muted">${group.skills.length}</span>
                        </summary>
                        <div class="list skills-grid">
                          ${group.skills.map((skill) => {
                            const learned = isWorkshopSkill(skill);
                            const enabled = learned || !usingAllowlist || allowSet.has(skill.name);
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
                                  ${(
                                    [
                                      ["agents.skillsPanel.missing", missing],
                                      ["agents.skillsPanel.reason", reasons],
                                    ] as const
                                  ).map(([label, items]) =>
                                    items.length > 0
                                      ? html`<span class="settings-row__desc">
                                          ${t(label, { items: items.join(", ") })}
                                        </span>`
                                      : nothing,
                                  )}
                                  ${
                                    learned
                                      ? html`<span class="settings-row__desc">
                                          ${t("agents.skillsPanel.learnedAlwaysOn")}
                                        </span>`
                                      : nothing
                                  }
                                </div>
                                <div class="settings-row__control">
                                  ${renderSettingsToggle({
                                    checked: enabled,
                                    disabled: learned || !editable,
                                    ariaLabel: skill.name,
                                    onChange: (checked) =>
                                      params.onToggle(params.agentId, skill.name, checked),
                                  })}
                                </div>
                              </div>
                            `;
                          })}
                        </div>
                      </details>
                    `,
                  )}
                </div>
              `
        }
      `,
    )}
  `;
}
