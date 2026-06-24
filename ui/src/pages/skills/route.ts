import { html } from "lit";
import { titleForRoute, subtitleForRoute } from "../../app-navigation.ts";
import type { SettingsAppHost } from "../../app/app-host.ts";
import { definePage } from "../../router/index.ts";
import type { AppViewState } from "../../ui/app-view-state.ts";
import { loadAgents } from "../agents/data.ts";
import {
  closeClawHubDetail,
  installFromClawHub,
  installSkill,
  loadClawHubDetail,
  loadSkillCard,
  loadSkills,
  reconcileSkillsAgentId,
  saveSkillApiKey,
  searchClawHub,
  setClawHubSearchQuery,
  setSkillsAgentId,
  updateSkillEdit,
  updateSkillEnabled,
} from "./data.ts";

type SkillsLoadContext = { app: SettingsAppHost };
type SkillsRenderContext = { state: AppViewState };

let clawhubSearchTimer: ReturnType<typeof setTimeout> | null = null;

export const page = definePage({
  id: "skills",
  path: "/skills",
  component: () =>
    import("./view.ts").then((module) => ({
      header: true,
      render: ({ state }: SkillsRenderContext) => html`
        <section class="content-header">
          <div>
            <div class="page-title">${titleForRoute("skills")}</div>
            <div class="page-sub">${subtitleForRoute("skills")}</div>
          </div>
        </section>
        ${module.renderSkills({
          connected: state.connected,
          loading: state.skillsLoading,
          report: state.skillsReport,
          agentsList: state.agentsList,
          selectedAgentId: state.skillsAgentId ?? state.agentsList?.defaultId ?? null,
          error: state.skillsError,
          filter: state.skillsFilter,
          statusFilter: state.skillsStatusFilter,
          edits: state.skillEdits,
          messages: state.skillMessages,
          busyKey: state.skillsBusyKey,
          detailKey: state.skillsDetailKey,
          detailTab: state.skillsDetailTab,
          clawhubVerdicts: state.clawhubVerdicts,
          clawhubVerdictsLoading: state.clawhubVerdictsLoading,
          clawhubVerdictsError: state.clawhubVerdictsError,
          skillCardContents: state.skillCardContents,
          skillCardLoadingKey: state.skillCardLoadingKey,
          skillCardErrors: state.skillCardErrors,
          clawhubQuery: state.clawhubSearchQuery,
          clawhubResults: state.clawhubSearchResults,
          clawhubSearchLoading: state.clawhubSearchLoading,
          clawhubSearchError: state.clawhubSearchError,
          clawhubDetail: state.clawhubDetail,
          clawhubDetailSlug: state.clawhubDetailSlug,
          clawhubDetailLoading: state.clawhubDetailLoading,
          clawhubDetailError: state.clawhubDetailError,
          clawhubInstallSlug: state.clawhubInstallSlug,
          clawhubInstallMessage: state.clawhubInstallMessage,
          onAgentChange: (agentId) => {
            setSkillsAgentId(state, agentId);
            void loadSkills(state, { clearMessages: true });
          },
          onFilterChange: (next) => (state.skillsFilter = next),
          onStatusFilterChange: (next) => (state.skillsStatusFilter = next),
          onRefresh: async () => {
            await loadAgents(state);
            reconcileSkillsAgentId(state, state.agentsList);
            await loadSkills(state, { clearMessages: true });
          },
          onToggle: (key, enabled) => void updateSkillEnabled(state, key, enabled),
          onEdit: (key, value) => updateSkillEdit(state, key, value),
          onSaveKey: (key) => void saveSkillApiKey(state, key),
          onInstall: (skillKey, name, installId) =>
            void installSkill(state, skillKey, name, installId),
          onDetailOpen: (key) => {
            state.skillsDetailKey = key;
            state.skillsDetailTab = "overview";
          },
          onDetailClose: () => (state.skillsDetailKey = null),
          onDetailTabChange: (tab) => {
            state.skillsDetailTab = tab;
            if (tab === "card" && state.skillsDetailKey) {
              void loadSkillCard(state, state.skillsDetailKey);
            }
          },
          onClawHubQueryChange: (query) => {
            setClawHubSearchQuery(state, query);
            if (clawhubSearchTimer) {
              clearTimeout(clawhubSearchTimer);
            }
            clawhubSearchTimer = setTimeout(() => void searchClawHub(state, query), 300);
          },
          onClawHubDetailOpen: (slug) => void loadClawHubDetail(state, slug),
          onClawHubDetailClose: () => closeClawHubDetail(state),
          onClawHubInstall: (slug) => void installFromClawHub(state, slug),
        })}
      `,
    })),
  loader: async ({ app }: SkillsLoadContext) => {
    await loadAgents(app);
    reconcileSkillsAgentId(app, app.agentsList);
    await loadSkills(app);
  },
});
