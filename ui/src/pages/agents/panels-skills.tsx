import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { For, createMemo } from "solid-js";
import type { SkillStatusReport } from "../../api/types.ts";
import {
  SettingsSection,
  SettingsRow,
  SettingsToggle,
  SettingsEmpty,
} from "../../components/solid/settings-ui.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { resolveAgentConfig, resolveAgentSkillsFilter } from "../../lib/agents/display.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { groupSkills } from "../../lib/skills-grouping.ts";
import {
  computeSkillMissing,
  computeSkillReasons,
  isWorkshopSkill,
  renderSkillStatusChips,
} from "../../lib/skills-shared.ts";
import { LitContent } from "../../lit/solid-bridge.ts";
import { AgentConfigButtons, type AgentConfigActions } from "./config-actions.tsx";
import { AgentPanelAction } from "./panel-ui.tsx";

registerSettingsEnglish();

export function AgentSkills(
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
  const configReady = () =>
    Boolean(params.configForm) && !params.configLoading && !params.configSaving;
  const editable = () => params.canUpdateConfig && configReady();
  const config = createMemo(() => resolveAgentConfig(params.configForm, params.agentId));
  const hasExplicitAllowlist = createMemo(() => Array.isArray(config().entry?.skills));
  const allowlist = createMemo(() => resolveAgentSkillsFilter(params.configForm, params.agentId));
  const allowSet = createMemo(() => new Set(allowlist() ?? []));
  const usingAllowlist = () => allowlist() !== undefined;
  const reportReady = () => Boolean(params.report && params.activeAgentId === params.agentId);
  const rawSkills = createMemo(() => (reportReady() ? (params.report?.skills ?? []) : []));
  const filter = createMemo(() => normalizeLowercaseStringOrEmpty(params.filter));
  const filtered = createMemo(() =>
    filter()
      ? rawSkills().filter((skill) =>
          normalizeLowercaseStringOrEmpty(
            [skill.name, skill.description, skill.source].join(" "),
          ).includes(filter()),
        )
      : rawSkills(),
  );
  const groups = createMemo(() => groupSkills(filtered()));
  const enabledCount = createMemo(() =>
    usingAllowlist()
      ? rawSkills().filter((skill) => isWorkshopSkill(skill) || allowSet().has(skill.name)).length
      : rawSkills().length,
  );

  return (
    <>
      {!params.configForm ? (
        <div class="callout info">{t("agents.skillsPanel.loadConfig")}</div>
      ) : undefined}
      <div class="callout info">
        {t(
          usingAllowlist()
            ? !hasExplicitAllowlist()
              ? "agents.skillsPanel.inheritedAllowlist"
              : "agents.skillsPanel.customAllowlist"
            : "agents.skillsPanel.allEnabled",
        )}
      </div>
      {!reportReady() && !params.loading ? (
        <div class="callout info">{t("agents.skillsPanel.loadAgent")}</div>
      ) : undefined}
      {params.error ? <div class="callout danger">{params.error}</div> : undefined}
      <SettingsSection
        title={t("agents.skillsPanel.title")}
        description={
          <>
            {t("agents.skillsPanel.subtitle")}
            {rawSkills().length > 0 ? (
              <span class="mono">
                {enabledCount()}/{rawSkills().length}
              </span>
            ) : undefined}
          </>
        }
        actions={
          <>
            <AgentPanelAction
              label={t("agentTools.disableAll")}
              disabled={!editable()}
              onClick={() => params.onDisableAll(params.agentId)}
            />
            <AgentPanelAction
              label={t("common.reset")}
              disabled={!params.canPatchConfig || !hasExplicitAllowlist() || !configReady()}
              onClick={() => params.onClear(params.agentId)}
            />
            <AgentConfigButtons {...params}>
              <AgentPanelAction
                label={params.loading ? t("common.loading") : t("common.refresh")}
                disabled={params.loading}
                onClick={params.onRefresh}
              />
            </AgentConfigButtons>
          </>
        }
      >
        <SettingsRow
          title={t("agents.skillsPanel.filter")}
          description={t("agents.skillsPanel.shown", { count: String(filtered().length) })}
          control={
            <input
              class="settings-input"
              aria-label={t("agents.skillsPanel.filter")}
              value={params.filter}
              onInput={(event) => params.onFilterChange(event.currentTarget.value)}
              placeholder={t("agents.skillsPanel.searchPlaceholder")}
              autocomplete="off"
              name="agent-skills-filter"
            />
          }
        />
        {filtered().length === 0 ? (
          <SettingsEmpty message={t("agents.skillsPanel.empty")} />
        ) : (
          <div class="agents-panel-body agent-skills-groups">
            <For each={groups()} keyed={(group) => group.id}>
              {(group) => (
                <details
                  class="agent-skills-group"
                  open={
                    Boolean(filter()) || (group().id !== "workspace" && group().id !== "built-in")
                  }
                >
                  <summary class="agent-skills-header">
                    <span>{group().label}</span>
                    <span class="muted">{group().skills.length}</span>
                  </summary>
                  <div class="list skills-grid">
                    <For each={group().skills} keyed={(skill) => skill.name}>
                      {(skill) => {
                        const learned = () => isWorkshopSkill(skill());
                        const enabled = () =>
                          learned() || !usingAllowlist() || allowSet().has(skill().name);
                        return (
                          <div class="settings-row agent-skill-row">
                            <div class="settings-row__text">
                              <span class="settings-row__title">
                                {skill().emoji ? `${skill().emoji} ` : ""}
                                {skill().name}
                              </span>
                              <span class="settings-row__desc">{skill().description}</span>
                              <LitContent
                                render={() => renderSkillStatusChips({ skill: skill() })}
                              />
                              <For
                                each={
                                  [
                                    ["agents.skillsPanel.missing", computeSkillMissing(skill())],
                                    ["agents.skillsPanel.reason", computeSkillReasons(skill())],
                                  ] as const
                                }
                              >
                                {(entry) =>
                                  entry[1].length > 0 ? (
                                    <span class="settings-row__desc">
                                      {t(entry[0], { items: entry[1].join(", ") })}
                                    </span>
                                  ) : undefined
                                }
                              </For>
                              {learned() ? (
                                <span class="settings-row__desc">
                                  {t("agents.skillsPanel.learnedAlwaysOn")}
                                </span>
                              ) : undefined}
                            </div>
                            <div class="settings-row__control">
                              <SettingsToggle
                                checked={enabled()}
                                disabled={learned() || !editable()}
                                ariaLabel={skill().name}
                                onChange={(checked) =>
                                  params.onToggle(params.agentId, skill().name, checked)
                                }
                              />
                            </div>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                </details>
              )}
            </For>
          </div>
        )}
      </SettingsSection>
    </>
  );
}
