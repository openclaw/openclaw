import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import {
  Errored,
  For,
  Loading,
  Show,
  action,
  createDeferred,
  createMemo,
  createOptimistic,
  createSignal,
  isPending,
  latest,
  onSettled,
  refresh,
} from "solid-js";
import type { SkillStatusReport } from "../../api/types.ts";
import {
  SettingsSection,
  SettingsRow,
  SettingsToggle,
  SettingsEmpty,
} from "../../components/solid/settings-ui.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { resolveAgentConfig } from "../../lib/agents/display.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { groupSkills } from "../../lib/skills-grouping.ts";
import {
  computeSkillMissing,
  computeSkillReasons,
  isWorkshopSkill,
} from "../../lib/skills-shared.ts";
import { SkillStatusChips } from "../skills/skill-status.tsx";
import type { AgentsPageView } from "./agents-page-state.ts";
import { AgentConfigButtons, type AgentConfigActions } from "./config-actions.tsx";
import { AgentPanelAction } from "./panel-ui.tsx";

registerSettingsEnglish();

type AgentSkillsProps = AgentConfigActions &
  AgentsPageView["agentSkills"] &
  Pick<AgentsPageView, "readData"> & {
    agentId: string;
    configForm: Record<string, unknown> | null;
    canPatchConfig: boolean;
  };

export function AgentSkills(params: AgentSkillsProps) {
  const issued = createMemo(() => params.readData().agentSkillsRead);
  const cached = createMemo(() =>
    params.readData().agentSkillsAgentId === params.agentId
      ? params.readData().agentSkillsReport
      : null,
  );
  const scope = createMemo(() => `${params.agentId}:${params.readData().requestGeneration}`);
  return (
    <Show when={scope()} keyed>
      {(capturedScope) => {
        // Keep one list mounted; JSX reads this scope's cached report until the first result.
        const report = createDeferred<
          { report: SkillStatusReport | null; error?: string } | undefined
        >(
          async () => {
            const read = issued();
            const fallback = cached();
            try {
              return {
                report:
                  read?.agentId === params.agentId ? ((await read.result) ?? fallback) : fallback,
              };
            } catch (error) {
              return { report: fallback, error: formatUiError(error) };
            }
          },
          { loadingValue: undefined },
        );
        const pending = createMemo(() => report() === undefined || isPending(report));
        const config = createMemo(() => resolveAgentConfig(params.configForm, params.agentId));
        const [explicit, setExplicit] = createOptimistic(() =>
          Array.isArray(config().entry?.skills),
        );
        const [resetting, setResetting] = createOptimistic(false);
        const [command, setCommand] = createSignal<{ completion: Promise<void> } | null>(null);
        const allowlist = createMemo(() => {
          const skills = explicit() ? config().entry?.skills : config().defaults?.skills;
          return Array.isArray(skills) ? normalizeStringEntries(skills) : undefined;
        });
        const reset = action(function* (completion: Promise<void>) {
          setExplicit(false);
          setResetting(true);
          yield completion;
          if (latest(scope) === capturedScope) {
            yield refresh(explicit);
          }
        });
        const onClear = () => {
          const completion = params.onClear(params.agentId);
          if (!completion) {
            return;
          }
          setCommand({ completion });
          // Publish the new receipt before the action holds its pending frame.
          onSettled(() => {
            void reset(completion).catch(() => undefined);
          });
        };
        return (
          <AgentSkillsContent
            {...params}
            explicit={explicit()}
            allowlist={allowlist()}
            resetting={resetting()}
            command={command()}
            onClear={onClear}
            report={report()?.report ?? cached()}
            pending={pending()}
            readError={pending() ? undefined : report()?.error}
          />
        );
      }}
    </Show>
  );
}

function AgentSkillsContent(
  params: Omit<AgentSkillsProps, "onClear"> & {
    onClear: () => void;
    explicit: boolean;
    allowlist: string[] | undefined;
    resetting: boolean;
    command: { completion: Promise<void> } | null;
    report: SkillStatusReport | null;
    pending: boolean;
    readError?: string;
  },
) {
  const configReady = () =>
    Boolean(params.configForm) &&
    !params.configLoading &&
    !params.configSaving &&
    !params.resetting;
  const editable = () => params.canUpdateConfig && configReady();
  const allowSet = createMemo(() => new Set(params.allowlist ?? []));
  const usingAllowlist = () => params.allowlist !== undefined;
  const rawSkills = createMemo(() => params.report?.skills ?? []);
  const searchableSkills = createMemo(() =>
    rawSkills().map((skill) => ({
      skill,
      text: normalizeLowercaseStringOrEmpty(
        [skill.name, skill.description, skill.source].join(" "),
      ),
    })),
  );
  const filter = createMemo(() => normalizeLowercaseStringOrEmpty(params.filter));
  const filtered = createMemo(
    () =>
      filter()
        ? searchableSkills()
            .filter((entry) => entry.text.includes(filter()))
            .map((entry) => entry.skill)
        : rawSkills(),
    {
      equals: (previous, next) =>
        previous.length === next.length && previous.every((skill, index) => skill === next[index]),
    },
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
            ? !params.explicit
              ? "agents.skillsPanel.inheritedAllowlist"
              : "agents.skillsPanel.customAllowlist"
            : "agents.skillsPanel.allEnabled",
        )}
      </div>
      {!params.report && !params.pending ? (
        <div class="callout info">{t("agents.skillsPanel.loadAgent")}</div>
      ) : undefined}
      {params.readError ? (
        <div class="callout danger">{params.readError}</div>
      ) : (
        <Show when={params.command} keyed>
          {(command) => (
            <Errored
              fallback={(error) => <div class="callout danger">{formatUiError(error())}</div>}
            >
              <AgentSkillsResetCompletion completion={command.completion} />
            </Errored>
          )}
        </Show>
      )}
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
              label={t(params.resetting ? "common.saving" : "common.reset")}
              disabled={!params.canPatchConfig || !params.explicit || !configReady()}
              onClick={() => params.onClear()}
            />
            <AgentConfigButtons {...params}>
              <AgentPanelAction
                label={params.pending ? t("common.loading") : t("common.refresh")}
                disabled={params.pending}
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
                              <SkillStatusChips skill={skill()} />
                              <For
                                each={
                                  [
                                    ["agents.skillsPanel.missing", computeSkillMissing(skill())],
                                    ["agents.skillsPanel.reason", computeSkillReasons(skill())],
                                  ] as const
                                }
                                keyed={(entry) => entry[0]}
                              >
                                {(entry) => (
                                  <Show when={entry()[1].length > 0}>
                                    <span class="settings-row__desc">
                                      {t(entry()[0], { items: entry()[1].join(", ") })}
                                    </span>
                                  </Show>
                                )}
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

function AgentSkillsResetCompletion(params: { completion: Promise<void> }) {
  const settled = createMemo(async () => {
    await params.completion;
    return null;
  });
  return <Loading fallback={null}>{settled()}</Loading>;
}
