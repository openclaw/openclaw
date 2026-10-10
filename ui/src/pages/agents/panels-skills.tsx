import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { For, createMemo } from "solid-js";
import type { SkillStatusReport } from "../../api/types.ts";
import { LitContent } from "../../components/solid/lit-content.tsx";
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
  const configReady = createMemo(
    () => Boolean(params.configForm) && !params.configLoading && !params.configSaving,
  );
  const editable = createMemo(() => params.canUpdateConfig && configReady());
  const config = createMemo(() => resolveAgentConfig(params.configForm, params.agentId));
  const hasExplicitAllowlist = createMemo(() => Array.isArray(config().entry?.skills));
  const allowlist = createMemo(() => resolveAgentSkillsFilter(params.configForm, params.agentId));
  const allowSet = createMemo(() => new Set(allowlist() ?? []));
  const usingAllowlist = createMemo(() => allowlist() !== undefined);
  const inheritedAllowlist = createMemo(() => !hasExplicitAllowlist() && usingAllowlist());
  const canClear = createMemo(
    () => params.canPatchConfig && hasExplicitAllowlist() && configReady(),
  );
  const reportReady = createMemo(() =>
    Boolean(params.report && params.activeAgentId === params.agentId),
  );
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
  const totalCount = createMemo(() => rawSkills().length);

  return (
    <>
      {!params.configForm ? (
        <div class="callout info">{t("agents.skillsPanel.loadConfig")}</div>
      ) : undefined}
      <div class="callout info">
        {t(
          usingAllowlist()
            ? inheritedAllowlist()
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
            {totalCount() > 0 ? (
              <span class="mono">
                {enabledCount()}/{totalCount()}
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
              disabled={!canClear()}
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
        <>
          <SettingsRow
            title={t("agents.skillsPanel.filter")}
            description={t("agents.skillsPanel.shown", { count: String(filtered().length) })}
            control={
              <input
                class="settings-input"
                aria-label={t("agents.skillsPanel.filter")}
                prop:value={params.filter}
                onInput={(event: Event) => {
                  const input = event.currentTarget;
                  if (input instanceof HTMLInputElement) {
                    params.onFilterChange(input.value);
                  }
                }}
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
                          const learned = createMemo(() => isWorkshopSkill(skill()));
                          const enabled = createMemo(
                            () => learned() || !usingAllowlist() || allowSet().has(skill().name),
                          );
                          const missing = createMemo(() => computeSkillMissing(skill()));
                          const reasons = createMemo(() => computeSkillReasons(skill()));
                          return (
                            <div class="settings-row agent-skill-row">
                              <div class="settings-row__text">
                                <span class="settings-row__title">
                                  {skill().emoji ? `${skill().emoji} ` : ""}
                                  {skill().name}
                                </span>
                                <span class="settings-row__desc">{skill().description}</span>
                                <LitContent
                                  content={() => renderSkillStatusChips({ skill: skill() })}
                                />
                                <For
                                  each={
                                    [
                                      ["agents.skillsPanel.missing", missing()],
                                      ["agents.skillsPanel.reason", reasons()],
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
        </>
      </SettingsSection>
    </>
  );
}
