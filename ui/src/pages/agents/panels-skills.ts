import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { html, nothing } from "lit";
import type { SkillStatusReport } from "../../api/types.ts";
import {
  renderSettingsEmpty,
  renderSettingsRow,
  renderSettingsSection,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { groupSkills } from "../../lib/skills-grouping.ts";
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
  filter: string;
  onFilterChange: (next: string) => void;
  onRefresh: () => void;
}) {
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
  const totalCount = rawSkills.length;

  return html`
    <div class="callout info">${t("agents.skillsPanel.allEligible")}</div>
    ${
      !reportReady && !params.loading
        ? html`<div class="callout info">${t("agents.skillsPanel.loadAgent")}</div>`
        : nothing
    }
    ${params.error ? html`<div class="callout danger">${params.error}</div>` : nothing}
    ${renderSettingsSection(
      {
        title: t("agents.skillsPanel.title"),
        description: html`${t("agents.skillsPanel.inventorySubtitle")}
        ${totalCount > 0 ? html`<span class="mono">${totalCount}</span>` : nothing}`,
        actions: html`<button
          class="btn btn--sm"
          ?disabled=${params.loading}
          @click=${params.onRefresh}
        >
          ${params.loading ? t("common.loading") : t("common.refresh")}
        </button>`,
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
