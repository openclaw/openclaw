import { createEffect, createMemo, createStore, onCleanup } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SkillStatusReport } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  hasOperatorAdminAccess,
  hasOperatorReadAccess,
  hasOperatorWriteAccess,
} from "../../app/operator-access.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsPageHeader } from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { createPageRequest } from "../../lib/page-request.ts";
import { projectApplicationConfig } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectAgents } from "../../lib/reactive/domain-capabilities.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { searchClawHub } from "../../lib/skills/clawhub-search.ts";
import {
  closeClawHubDetail,
  installFromClawHub,
  installSkill,
  loadClawHubDetail,
  loadClawHubSecurityVerdicts,
  loadSkillCard,
  loadSkills,
  refreshSkills,
  reconcileSkillsAgentId,
  saveSkillApiKey,
  setSkillsAgentId,
  updateSkillEdit,
  updateSkillEnabled,
  type SkillsState,
} from "../../lib/skills/index.ts";
import { PluginIconOwner, pluginIconFetchContext } from "../plugins/plugin-icon-owner.ts";
import { PluginsHubHeader } from "../plugins/plugins-hub-header.tsx";
import { PLUGINS_HUB_PANEL_ID } from "../plugins/plugins-hub.ts";
import { createSkillLibrary } from "./library-state.ts";
import { SkillLibrary, SkillLibraryDialogs, SkillLibraryFeedback } from "./library-view.tsx";
import { observeSkillState } from "./observe-state.ts";
import type { SkillDetailTab, SkillsPresentation } from "./view-types.ts";
import { Skills } from "./view.tsx";

function createSkillsData(): Omit<SkillsState, "client" | "connected" | "runtimeConfig"> {
  return {
    skillsAgentId: null,
    skillsAgentRevision: 0,
    skillsLoading: false,
    skillsReport: null,
    skillsError: null,
    skillOperation: null,
    skillEdits: {},
    skillMessages: {},
    clawhubSearchResults: null,
    clawhubSearchLoading: false,
    clawhubSearchError: null,
    clawhubDetail: null,
    clawhubDetailRef: null,
    clawhubDetailLoading: false,
    clawhubDetailError: null,
    clawhubInstallMessage: null,
    clawhubVerdicts: {},
    clawhubVerdictsLoading: false,
    clawhubVerdictsError: null,
    skillCardContents: {},
    skillCardContentKeys: {},
    skillCardLoadingKey: null,
    skillCardErrors: {},
    clawhubIconUrls: {},
  };
}

export type SkillsRouteData = {
  gateway: ApplicationContext["gateway"];
  gatewaySnapshot: ApplicationGatewaySnapshot;
  agents: ApplicationContext["agents"];
  selectedAgentId: string | null;
  selectionIntentRevision: number;
  report: SkillStatusReport | null;
  error: string | null;
  clawhubRef?: string;
};

export type SkillsPageProps = { routeData?: SkillsRouteData; surface?: "discovery" | "settings" };

export function SkillsPage(props: SkillsPageProps) {
  const context = useApplication();
  const surface = () => props.surface ?? "settings";
  const [local, setLocal] = createStore<SkillsPresentation>({
    skillsFilter: "",
    skillsStatusFilter: "all",
    skillsDetailKey: null,
    skillsDetailTab: "overview",
    clawhubSearchQuery: "",
  });
  let clawhubSearchTimer: ReturnType<typeof setTimeout> | null = null;
  let routeDataInitialized = false;
  let routeDataEnabled = true;
  let accessSignature = "";
  const skills = observeSkillState<SkillsState>({
    ...createSkillsData(),
    get client() {
      return gateway.client;
    },
    get connected() {
      return gateway.connected;
    },
    get runtimeConfig() {
      return context.runtimeConfig;
    },
  });
  const data = skills.state;
  const searchRequest = createPageRequest(
    () => {
      data.clawhubSearchLoading = searchRequest.pending;
    },
    {
      task: (client: GatewayBrowserClient, { signal }) =>
        searchClawHub(client, local.clawhubSearchQuery, signal),
      onComplete: (results) => {
        data.clawhubSearchResults = results;
      },
      onError: (error) => {
        data.clawhubSearchError = formatUiError(error);
      },
    },
  );
  const gateway = useGatewayPage({
    getGateway: () => context.gateway,
    onIdentityChange: resetLoadedSkillState,
    onSnapshot: ({ snapshot }) => {
      if (snapshot.phase !== "connected" || !snapshot.hello) {
        return;
      }
      const auth = snapshot.hello.auth ?? null;
      const nextAccess = [
        hasOperatorReadAccess(auth),
        hasOperatorWriteAccess(auth),
        hasOperatorAdminAccess(auth),
      ];
      const nextSignature = nextAccess.join(":");
      if (accessSignature === nextSignature) {
        return;
      }
      accessSignature = nextSignature;
      gateway.invalidate();
      invalidateSkillRequests();
      if (!nextAccess[0]) {
        resetLoadedSkillState();
      } else {
        if (!nextAccess[1]) {
          library.reset();
        }
        if (!nextAccess[2]) {
          data.skillEdits = {};
        }
      }
    },
    invalidateRequests: invalidateSkillRequests,
    ensureInitialData: (change) => {
      if (change.becameConnected && !change.initial) {
        void loadSkills(data);
        void library.load();
      }
      ensureInitialData();
    },
  });
  const viewState = createMemo(() => ({ ...skills.read(), ...local }));
  const config = context.config ? projectApplicationConfig(context.config) : undefined;
  const library = createSkillLibrary(gateway, () => {
    config?.revision();
    return context.config;
  });
  const clawhubIcons = new PluginIconOwner({
    kind: "catalog",
    getFetchContext: () => pluginIconFetchContext(context),
    isConnected: () => gateway.connected,
    onUrlsChange: (urls) => {
      data.clawhubIconUrls = urls;
    },
  });
  const agents = projectAgents(context.agents);
  // Agent and route receipts retarget the skills owner and its Gateway reads.
  createEffect(
    () => agents.revision(),
    () => {
      reconcileAgentState();
      ensureInitialData();
    },
  );

  createEffect(
    () => agentSelection(),
    (selection) => {
      const sync = () => {
        const previous = data.skillsAgentId;
        reconcileAgentState();
        if (routeDataInitialized && previous !== data.skillsAgentId) {
          routeDataEnabled = false;
          ensureInitialData();
        }
      };
      // Each agent transition retires prior skill requests, preserving A-to-B-to-A changes before rendering.
      const cleanup = selection.subscribe(sync);
      sync();
      return cleanup;
    },
  );
  createEffect(
    () => props.routeData,
    () => {
      applyRouteData();
      ensureInitialData();
    },
  );
  // Keep the catalog image cache aligned with the currently loaded ClawHub entries.
  createEffect(
    () => [skills.read().clawhubSearchResults, skills.read().clawhubDetail] as const,
    () => {
      clawhubIcons.syncCatalog(
        [],
        [
          ...(data.clawhubSearchResults ?? []).flatMap((result) =>
            result.icon ? [result.icon] : [],
          ),
          ...(data.clawhubDetail?.skill?.icon ? [data.clawhubDetail.skill.icon] : []),
          ...(data.clawhubDetail?.owner?.image ? [data.clawhubDetail.owner.image] : []),
        ],
      );
    },
  );
  const searchContext = createMemo(
    () => [gateway.client, gateway.connected, gateway.epoch, surface()] as const,
    { equals: (previous, next) => previous.every((value, index) => value === next[index]) },
  );
  createEffect(searchContext, ([, connected]) => {
    // Gateway binding can connect first; restart the cancellable ClawHub request on connection.
    if (connected) {
      void runSearch();
    }
  });
  onCleanup(() => {
    clearClawHubSearchTimer();
    searchRequest.cancel();
    skills.dispose();
    clawhubIcons.reset();
  });

  async function runSearch() {
    searchRequest.cancel();
    data.clawhubSearchError = null;
    data.clawhubSearchLoading = gateway.connected && canReadSkills() && surface() === "discovery";
    const client = gateway.client;
    if (!data.clawhubSearchLoading || !client || clawhubSearchTimer) {
      return;
    }
    await searchRequest.run(client);
  }

  function agentSelection() {
    return surface() === "settings" ? context.settingsAgentSelection : context.agentSelection;
  }

  function reconcileAgentState() {
    const agentState = context.agents.state;
    const previousAgentId = data.skillsAgentId;
    setSkillsAgentId(data, agentSelection().state.selectedId);
    if (surface() === "discovery" && agentState.agentsList) {
      reconcileSkillsAgentId(data, agentState.agentsList);
    }
    if (previousAgentId !== data.skillsAgentId) {
      selectSkill(null);
      closeClawHubDetail(data);
    }
  }

  function invalidateSkillRequests() {
    data.skillsAgentRevision++;
    data.skillsLoading = false;
    data.skillOperation = null;
    data.clawhubDetailLoading = false;
    data.clawhubVerdictsLoading = false;
    data.skillCardLoadingKey = null;
    data.clawhubSearchLoading = false;
    searchRequest.cancel();
    clearClawHubSearchTimer();
    clawhubIcons.reconcileKeys(new Set(Object.keys(data.clawhubIconUrls)));
    library.invalidateRequests();
  }

  function resetLoadedSkillState() {
    library.reset();
    searchRequest.cancel();
    clearClawHubSearchTimer();
    if (routeDataInitialized) {
      routeDataEnabled = false;
    }
    selectSkill(null);
    Object.assign(data, createSkillsData(), {
      skillsAgentRevision: data.skillsAgentRevision + 1,
    });
    clawhubIcons.reset();
  }

  function applyRouteData() {
    const route = props.routeData;
    if (!route) {
      return;
    }
    routeDataInitialized = true;
    routeDataEnabled = true;
    if (!gateway.isRouteDataCurrent(route) || route.agents !== context.agents || !canReadSkills()) {
      routeDataEnabled = false;
      return;
    }
    const selection = agentSelection().state;
    // A preload may finish after another explicit choice, including an A→B→A switch.
    if (agentSelection().intentRevision !== route.selectionIntentRevision) {
      routeDataEnabled = false;
      reconcileAgentState();
      return;
    }
    setSkillsAgentId(data, route.selectedAgentId);
    if (route.selectedAgentId && selection.selectedId !== route.selectedAgentId) {
      agentSelection().set(route.selectedAgentId);
    }
    reconcileAgentState();
    if (data.skillsAgentId !== route.selectedAgentId) {
      routeDataEnabled = false;
      return;
    }
    routeDataEnabled = true;
    data.skillsLoading = false;
    data.skillsReport = route.report;
    data.skillsError = route.error;
    if (route.report) {
      void loadClawHubSecurityVerdicts(data, route.report);
    }
    if (route.clawhubRef && route.clawhubRef !== data.clawhubDetailRef) {
      void loadClawHubDetail(data, route.clawhubRef);
    }
  }

  function ensureInitialData() {
    if (!canReadSkills()) {
      return;
    }
    if (!library.state.list && !library.state.loading && !library.state.error) {
      void library.load();
    }
    if (routeDataEnabled || !routeDataInitialized || !gateway.connected || !gateway.client) {
      return;
    }
    const agentState = context.agents.state;
    if (!agentState.agentsList) {
      if (!agentState.agentsLoading) {
        void loadAgents();
      }
      return;
    }
    reconcileAgentState();
    if (!data.skillsReport && !data.skillsLoading) {
      void loadSkills(data);
    }
  }

  function canReadSkills() {
    return hasOperatorReadAccess(gateway.snapshot?.hello?.auth ?? null);
  }

  async function loadAgents() {
    const source = context.agents;
    await source.ensureList();
    if (context.agents === source) {
      reconcileAgentState();
    }
  }

  async function refreshPage() {
    await Promise.all([refreshSkills(data, loadAgents), library.load()]);
  }

  function changeClawHubQuery(query: string) {
    setLocal((state) => {
      state.clawhubSearchQuery = query;
    });
    data.clawhubSearchResults = null;
    data.clawhubSearchError = null;
    data.clawhubSearchLoading = true;
    data.clawhubInstallMessage = null;
    clearClawHubSearchTimer();
    searchRequest.cancel();
    clawhubSearchTimer = setTimeout(() => {
      clawhubSearchTimer = null;
      void runSearch();
    }, 300);
  }

  function clearClawHubSearchTimer() {
    if (clawhubSearchTimer) {
      clearTimeout(clawhubSearchTimer);
      clawhubSearchTimer = null;
    }
  }

  function selectSkill(key: string | null) {
    setLocal((state) => {
      state.skillsDetailKey = key;
      state.skillsDetailTab = "overview";
    });
  }

  function changeDetailTab(tab: SkillDetailTab) {
    setLocal((state) => {
      state.skillsDetailTab = tab;
    });
    if (tab === "card" && local.skillsDetailKey) {
      void loadSkillCard(data, local.skillsDetailKey);
    }
  }

  function canUpdateSkills(): boolean {
    return canCallGatewayMethod(gateway.snapshot, "skills.update", "operator.admin");
  }

  function canInstallSkills(): boolean {
    return canCallGatewayMethod(gateway.snapshot, "skills.install", "operator.admin");
  }

  function canInstallFromClawHub(): boolean {
    // The library owns the destination; a pending or failed first load is not workspace consent.
    const current = library.state;
    return (
      current.list !== null &&
      !current.loading &&
      (library.showWorkspace()
        ? canInstallSkills()
        : library.canWrite() && Boolean(current.list.profileId))
    );
  }

  function navigateSkills(route: "skills" | "skill-settings") {
    context.navigate(route, {
      search: data.skillsAgentId ? `?agent=${encodeURIComponent(data.skillsAgentId)}` : "",
    });
  }

  return (
    <openclaw-skills-page>
      {surface() === "discovery" ? (
        <PluginsHubHeader
          active="skills"
          onSelect={(tab) => {
            if (tab !== "skills") {
              context.navigate(tab);
            }
          }}
          secondaryAction={{
            label: t("skillDiscovery.settings"),
            icon: <Icon name="settings" />,
            onClick: () => navigateSkills("skill-settings"),
          }}
        />
      ) : (
        <SettingsPageHeader title={t("tabs.skills")} subtitle={t("subtitles.skills")} />
      )}
      <SettingsWorkspace>
        <div
          id={surface() === "discovery" ? PLUGINS_HUB_PANEL_ID : undefined}
          role={surface() === "discovery" ? "tabpanel" : undefined}
          aria-labelledby={surface() === "discovery" ? "plugins-tab-skills" : undefined}
        >
          <Skills
            state={viewState()}
            surface={surface()}
            libraryEntries={library.state.list?.entries ?? []}
            onLibraryOpen={(skillId) => void library.open(skillId)}
            library={
              surface() === "discovery" ? (
                <>
                  <SkillLibraryFeedback library={library} />
                  <SkillLibraryDialogs library={library} />
                </>
              ) : (
                <SkillLibrary
                  library={library}
                  navigationActions={
                    <>
                      <button type="button" class="btn" onClick={() => navigateSkills("skills")}>
                        <Icon name="search" />
                        {t("skillDiscovery.search")}
                      </button>
                      <button
                        type="button"
                        class="btn"
                        onClick={() => context.navigate("skill-workshop")}
                      >
                        {t("pluginsPage.workshopTab")}
                      </button>
                    </>
                  }
                />
              )
            }
            showInventory={library.showWorkspace()}
            canUpdate={canUpdateSkills()}
            canInstall={canInstallFromClawHub()}
            loading={
              skills.read().skillsLoading || agents.read().agentsLoading || library.state.busy
            }
            error={skills.read().skillsError ?? agents.read().agentsError}
            onFilterChange={(next) =>
              setLocal((state) => {
                state.skillsFilter = next;
              })
            }
            onStatusFilterChange={(next) =>
              setLocal((state) => {
                state.skillsStatusFilter = next;
              })
            }
            onRefresh={() => void refreshPage()}
            onToggle={(key, enabled) => {
              if (canUpdateSkills()) {
                void updateSkillEnabled(data, key, enabled, canUpdateSkills);
              }
            }}
            onEdit={(key, value) => {
              if (canUpdateSkills()) {
                updateSkillEdit(data, key, value);
              }
            }}
            onSaveKey={(key) => {
              if (canUpdateSkills()) {
                void saveSkillApiKey(data, key, canUpdateSkills);
              }
            }}
            onInstall={(skillKey, name, installId) => {
              if (canInstallSkills()) {
                void installSkill(data, skillKey, name, installId);
              }
            }}
            onDetailOpen={selectSkill}
            onDetailClose={() =>
              setLocal((state) => {
                state.skillsDetailKey = null;
              })
            }
            onDetailTabChange={changeDetailTab}
            onClawHubQueryChange={changeClawHubQuery}
            onClawHubDetailOpen={(ref) => void loadClawHubDetail(data, ref)}
            onClawHubDetailClose={() => closeClawHubDetail(data)}
            onClawHubInstall={(ref, version) => {
              if (!canInstallFromClawHub()) {
                return;
              }
              if (!library.showWorkspace()) {
                data.clawhubDetailRef = null;
                library.edit((state) => {
                  state.importSource = { slug: ref, version };
                  state.importSlug = "";
                });
                library.setImportOpen(true);
              } else {
                void installFromClawHub(data, ref, version);
              }
            }}
          />
        </div>
      </SettingsWorkspace>
    </openclaw-skills-page>
  );
}
declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-skills-page": HTMLAttributes<HTMLElement>;
    }
  }
}
