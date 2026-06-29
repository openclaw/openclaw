import { html } from "lit";
import { titleForRoute, subtitleForRoute } from "../../app-navigation.ts";
import type { SettingsAppHost, SettingsHost } from "../../app/app-host.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import { normalizeStringEntries } from "../../lib/string-coerce.ts";
import { definePage } from "../../router/index.ts";
import type { AppViewState } from "../../ui/app-view-state.ts";
import {
  resolveAgentConfig,
  resolveEffectiveModelFallbacks,
  resolveModelPrimary,
} from "../../ui/views/agents-utils.ts";
import { loadChannels } from "../channels/data.ts";
import { loadConfig, removeConfigFormValue, updateConfigFormValue } from "../config/data.ts";
import { ensureAgentConfigEntry, findAgentConfigEntryIndex } from "../config/data.ts";
import { runCronJob } from "../cron/data.ts";
import {
  buildToolsEffectiveRequestKey,
  loadAgents,
  loadToolsCatalog,
  loadToolsEffective,
  loadAgentsPage,
  resetToolsEffectiveState,
  refreshVisibleToolsEffectiveForCurrentSession,
  saveAgentsConfig,
  setDefaultAgent,
} from "./data.ts";
import { loadAgentFileContent, loadAgentFiles, saveAgentFile } from "./files.ts";
import { loadAgentIdentities, loadAgentIdentity } from "./identity.ts";
import { loadAgentSkills } from "./skills.ts";

type AgentsLoadContext = { host: SettingsHost; app: SettingsAppHost };
type AgentsRenderContext = { state: AppViewState };

function runTask<Args extends unknown[]>(
  task: (...args: Args) => Promise<unknown>,
): (...args: Args) => void {
  return (...args) => {
    void task(...args);
  };
}

export const page = definePage({
  id: "agents",
  path: "/agents",
  loader: async ({ host, app }: AgentsLoadContext) => {
    await loadAgentsPage(host, app);
  },
  component: () =>
    import("./view.ts").then((module) => ({
      header: true,
      render: ({ state }: AgentsRenderContext) => {
        const currentConfig = () =>
          state.configForm ?? (state.configSnapshot?.config as Record<string, unknown> | null);
        const selectedAgentId = () =>
          state.agentsSelectedId ??
          state.agentsList?.defaultId ??
          state.agentsList?.agents?.[0]?.id ??
          null;
        const agentId = selectedAgentId();
        const findAgentIndex = (id: string) => findAgentConfigEntryIndex(currentConfig(), id);
        const ensureAgentIndex = (id: string) => ensureAgentConfigEntry(state, id);
        const toolsPath = (id: string, ensure: boolean) => {
          const index = ensure ? ensureAgentIndex(id) : findAgentIndex(id);
          return index >= 0 ? (["agents", "list", index, "tools"] as const) : null;
        };
        const modelEntry = (index: number) => {
          const list = (currentConfig() as { agents?: { list?: unknown[] } } | null)?.agents?.list;
          const existing = Array.isArray(list)
            ? (list[index] as { model?: unknown } | undefined)?.model
            : undefined;
          return { path: ["agents", "list", index, "model"] as Array<string | number>, existing };
        };
        const chatAgentId =
          parseAgentSessionKey(state.sessionKey)?.agentId ??
          state.assistantAgentId ??
          state.agentsList?.defaultId ??
          "main";
        const loadPanel = (id: string | null) => {
          if (!id) {
            return;
          }
          if (state.agentsPanel === "files") {
            void loadAgentFiles(state, id);
          } else if (state.agentsPanel === "skills") {
            void loadAgentSkills(state, id);
          } else if (state.agentsPanel === "tools") {
            void loadToolsCatalog(state, id);
            void refreshVisibleToolsEffectiveForCurrentSession(state);
          } else if (state.agentsPanel === "channels") {
            void loadChannels(state, false);
          } else if (state.agentsPanel === "cron") {
            void state.loadCron();
          }
        };
        const resetSelection = () => {
          state.agentFilesList = null;
          state.agentFilesError = null;
          state.agentFileActive = null;
          state.agentFileContents = {};
          state.agentFileDrafts = {};
          state.agentFilesLoading = false;
          state.agentSkillsReport = null;
          state.agentSkillsError = null;
          state.agentSkillsAgentId = null;
          state.toolsCatalogResult = null;
          state.toolsCatalogError = null;
          state.toolsCatalogLoading = false;
          resetToolsEffectiveState(state);
        };

        return html`
          <section class="content-header">
            <div>
              <div class="page-title">${titleForRoute("agents")}</div>
              <div class="page-sub">${subtitleForRoute("agents")}</div>
            </div>
          </section>
          ${module.renderAgents({
            basePath: state.basePath ?? "",
            loading: state.agentsLoading,
            error: state.agentsError,
            agentsList: state.agentsList,
            selectedAgentId: agentId,
            activePanel: state.agentsPanel,
            config: {
              form: currentConfig(),
              loading: state.configLoading,
              saving: state.configSaving,
              dirty: state.configFormDirty,
            },
            channels: {
              snapshot: state.channelsSnapshot,
              loading: state.channelsLoading,
              error: state.channelsError,
              lastSuccess: state.channelsLastSuccess,
            },
            cron: {
              status: state.cronStatus,
              jobs: state.cronJobs,
              loading: state.cronLoading,
              error: state.cronError,
            },
            agentFiles: {
              list: state.agentFilesList,
              loading: state.agentFilesLoading,
              error: state.agentFilesError,
              active: state.agentFileActive,
              contents: state.agentFileContents,
              drafts: state.agentFileDrafts,
              saving: state.agentFileSaving,
            },
            agentIdentityLoading: state.agentIdentityLoading,
            agentIdentityError: state.agentIdentityError,
            agentIdentityById: state.agentIdentityById,
            agentSkills: {
              report: state.agentSkillsReport,
              loading: state.agentSkillsLoading,
              error: state.agentSkillsError,
              agentId: state.agentSkillsAgentId,
              filter: state.skillsFilter,
            },
            toolsCatalog: {
              loading: state.toolsCatalogLoading,
              error: state.toolsCatalogError,
              result: state.toolsCatalogResult,
            },
            toolsEffective: {
              loading: state.toolsEffectiveLoading,
              error: state.toolsEffectiveError,
              result: state.toolsEffectiveResult,
            },
            runtimeSessionKey: state.sessionKey,
            runtimeSessionMatchesSelectedAgent: agentId === chatAgentId,
            modelCatalog: state.chatModelCatalog ?? [],
            onRefresh: runTask(async () => {
              await loadAgents(state);
              const ids = state.agentsList?.agents?.map((entry) => entry.id) ?? [];
              if (ids.length > 0) {
                void loadAgentIdentities(state, ids);
              }
              loadPanel(selectedAgentId());
            }),
            onSelectAgent: (next) => {
              if (state.agentsSelectedId === next) {
                return;
              }
              state.agentsSelectedId = next;
              resetSelection();
              void loadAgentIdentity(state, next);
              loadPanel(next);
            },
            onSelectPanel: (panel) => {
              state.agentsPanel = panel;
              if (panel === "files" && agentId && state.agentFilesList?.agentId !== agentId) {
                resetSelection();
                void loadAgentFiles(state, agentId);
              }
              if (panel === "skills" && agentId) {
                void loadAgentSkills(state, agentId);
              }
              if (panel === "tools" && agentId) {
                if (state.toolsCatalogResult?.agentId !== agentId || state.toolsCatalogError) {
                  void loadToolsCatalog(state, agentId);
                }
                if (agentId === chatAgentId) {
                  const key = buildToolsEffectiveRequestKey(state, {
                    agentId,
                    sessionKey: state.sessionKey,
                  });
                  if (state.toolsEffectiveResultKey !== key || state.toolsEffectiveError) {
                    void loadToolsEffective(state, { agentId, sessionKey: state.sessionKey });
                  }
                } else {
                  resetToolsEffectiveState(state);
                }
              }
              if (panel === "channels") {
                void loadChannels(state, false);
              }
              if (panel === "cron") {
                void state.loadCron();
              }
            },
            onLoadFiles: (id) => void loadAgentFiles(state, id),
            onSelectFile: (name) => {
              state.agentFileActive = name;
              if (agentId) {
                void loadAgentFileContent(state, agentId, name);
              }
            },
            onFileDraftChange: (name, content) => {
              state.agentFileDrafts = { ...state.agentFileDrafts, [name]: content };
            },
            onFileReset: (name) => {
              state.agentFileDrafts = {
                ...state.agentFileDrafts,
                [name]: state.agentFileContents[name] ?? "",
              };
            },
            onFileSave: (name) => {
              if (agentId) {
                void saveAgentFile(
                  state,
                  agentId,
                  name,
                  state.agentFileDrafts[name] ?? state.agentFileContents[name] ?? "",
                );
              }
            },
            onToolsProfileChange: (id, profile, clearAllow) => {
              const path = toolsPath(id, Boolean(profile || clearAllow));
              if (!path) {
                return;
              }
              profile
                ? updateConfigFormValue(state, [...path, "profile"], profile)
                : removeConfigFormValue(state, [...path, "profile"]);
              if (clearAllow) {
                removeConfigFormValue(state, [...path, "allow"]);
              }
            },
            onToolsOverridesChange: (id, alsoAllow, deny) => {
              const path = toolsPath(id, alsoAllow.length > 0 || deny.length > 0);
              if (!path) {
                return;
              }
              alsoAllow.length
                ? updateConfigFormValue(state, [...path, "alsoAllow"], alsoAllow)
                : removeConfigFormValue(state, [...path, "alsoAllow"]);
              deny.length
                ? updateConfigFormValue(state, [...path, "deny"], deny)
                : removeConfigFormValue(state, [...path, "deny"]);
            },
            onConfigReload: () => void loadConfig(state, { discardPendingChanges: true }),
            onConfigSave: () => void saveAgentsConfig(state),
            onChannelsRefresh: () => void loadChannels(state, false),
            onCronRefresh: () => void state.loadCron(),
            onCronRunNow: (jobId) => {
              const job = state.cronJobs.find((entry) => entry.id === jobId);
              if (job) {
                void runCronJob(state, job, "force");
              }
            },
            onSkillsFilterChange: (next) => (state.skillsFilter = next),
            onSkillsRefresh: () => {
              if (agentId) {
                void loadAgentSkills(state, agentId);
              }
            },
            onAgentSkillToggle: (id, skillName, enabled) => {
              const index = ensureAgentIndex(id);
              if (index < 0 || !skillName.trim()) {
                return;
              }
              const list = (currentConfig() as { agents?: { list?: unknown[] } } | null)?.agents
                ?.list;
              const entry = Array.isArray(list)
                ? (list[index] as { skills?: unknown } | undefined)
                : undefined;
              const base = Array.isArray(entry?.skills)
                ? normalizeStringEntries(entry.skills)
                : (state.agentSkillsReport?.skills?.map((skill) => skill.name).filter(Boolean) ??
                  []);
              const next = new Set(base);
              enabled ? next.add(skillName.trim()) : next.delete(skillName.trim());
              updateConfigFormValue(state, ["agents", "list", index, "skills"], [...next]);
            },
            onAgentSkillsClear: (id) => {
              const index = findAgentIndex(id);
              if (index >= 0) {
                removeConfigFormValue(state, ["agents", "list", index, "skills"]);
              }
            },
            onAgentSkillsDisableAll: (id) => {
              const index = ensureAgentIndex(id);
              if (index >= 0) {
                updateConfigFormValue(state, ["agents", "list", index, "skills"], []);
              }
            },
            onModelChange: (id, modelId) => {
              const index = modelId ? ensureAgentIndex(id) : findAgentIndex(id);
              if (index < 0) {
                return;
              }
              const entry = modelEntry(index);
              if (!modelId) {
                removeConfigFormValue(state, entry.path);
              } else if (entry.existing && typeof entry.existing === "object") {
                const fallbacks = (entry.existing as { fallbacks?: unknown }).fallbacks;
                updateConfigFormValue(state, entry.path, {
                  primary: modelId,
                  ...(Array.isArray(fallbacks) ? { fallbacks } : {}),
                });
              } else {
                updateConfigFormValue(state, entry.path, modelId);
              }
              void refreshVisibleToolsEffectiveForCurrentSession(state);
            },
            onModelFallbacksChange: (id, fallbacks) => {
              const normalized = normalizeStringEntries(fallbacks);
              const config = currentConfig();
              const resolved = resolveAgentConfig(config, id);
              const primary =
                resolveModelPrimary(resolved.entry?.model) ??
                resolveModelPrimary(resolved.defaults?.model);
              const effective = resolveEffectiveModelFallbacks(
                resolved.entry?.model,
                resolved.defaults?.model,
              );
              const index =
                normalized.length > 0
                  ? primary
                    ? ensureAgentIndex(id)
                    : -1
                  : (effective?.length ?? 0) > 0 || findAgentIndex(id) >= 0
                    ? ensureAgentIndex(id)
                    : -1;
              if (index < 0) {
                return;
              }
              const entry = modelEntry(index);
              const currentPrimary =
                typeof entry.existing === "string"
                  ? entry.existing.trim()
                  : entry.existing &&
                      typeof entry.existing === "object" &&
                      typeof (entry.existing as { primary?: unknown }).primary === "string"
                    ? (entry.existing as { primary: string }).primary.trim()
                    : "";
              if (normalized.length === 0) {
                currentPrimary || primary
                  ? updateConfigFormValue(state, entry.path, currentPrimary || primary)
                  : removeConfigFormValue(state, entry.path);
              } else if (currentPrimary || primary) {
                updateConfigFormValue(state, entry.path, {
                  primary: currentPrimary || primary,
                  fallbacks: normalized,
                });
              }
            },
            onSetDefault: (id) => {
              void setDefaultAgent(state, id);
            },
          })}
        `;
      },
    })),
});
