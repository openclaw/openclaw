import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { SkillStatusReport } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsPageHeader } from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
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
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { PluginIconController, pluginIconFetchContext } from "../plugins/plugin-icon-controller.ts";
import { PluginsHubHeader } from "../plugins/plugins-hub-header.tsx";
import { PLUGINS_HUB_PANEL_ID } from "../plugins/plugins-hub.ts";
import { SkillLibraryController } from "./library-controller.ts";
import { SkillLibrary, SkillLibraryDialogs, SkillLibraryFeedback } from "./library-view.tsx";
import type { SkillDetailTab } from "./view-types.ts";
import { Skills } from "./view.tsx";

function createSkillsData(): Omit<SkillsState, "client" | "connected" | "runtimeConfig"> {
  return {
    skillsAgentId: null,
    skillsAgentRevision: 0,
    skillsLoading: false,
    skillsReport: null,
    skillsError: null,
    skillOperation: null,
    skillsFilter: "",
    skillsStatusFilter: "all",
    skillEdits: {},
    skillMessages: {},
    skillsDetailKey: null,
    skillsDetailTab: "overview",
    clawhubSearchQuery: "",
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

class SkillsPageState {
  get routeData() {
    return this.props.routeData;
  }
  get surface() {
    return this.props.surface ?? "settings";
  }

  readonly state: SkillsState;

  get client() {
    return this.gateway.client;
  }

  get connected() {
    return this.gateway.connected;
  }

  private clawhubSearchTimer: ReturnType<typeof setTimeout> | null = null;
  private routeDataInitialized = false;
  private routeDataEnabled = true;
  readonly gateway: ReturnType<typeof useGatewayPage>;
  readonly library: SkillLibraryController;
  private readonly clawhubIcons: PluginIconController;
  private searchAbort: AbortController | null = null;
  private searchGeneration = 0;

  constructor(
    readonly context: ApplicationContext,
    readonly props: SkillsPageProps,
    readonly revision: () => number,
    readonly changed: () => void,
  ) {
    const readClient = () => this.client;
    const readConnected = () => this.connected;
    const readRuntimeConfig = () => this.context.runtimeConfig;
    // Domain methods mutate this owner synchronously; the signal only publishes revisions.
    this.state = new Proxy<SkillsState>(
      {
        ...createSkillsData(),
        get client() {
          return readClient();
        },
        get connected() {
          return readConnected();
        },
        get runtimeConfig() {
          return readRuntimeConfig();
        },
      },
      {
        get(target, key, receiver) {
          revision();
          return Reflect.get(target, key, receiver);
        },
        set(target, key, value, receiver) {
          if (Object.is(Reflect.get(target, key), value)) {
            return true;
          }
          const updated = Reflect.set(target, key, value, receiver);
          changed();
          return updated;
        },
      },
    );
    this.gateway = useGatewayPage({
      getGateway: () => this.context.gateway,
      invalidateRequests: () => this.resetLoadedSkillState(),
      ensureInitialData: () => this.ensureInitialData(),
    });
    const controller = new SkillLibraryController(
      { requestUpdate: changed },
      this.gateway,
      () => this.context.config,
    );
    this.library = new Proxy(controller, {
      get(target, key, receiver) {
        revision();
        return Reflect.get(target, key, receiver);
      },
    });
    this.clawhubIcons = new PluginIconController({
      kind: "catalog",
      getFetchContext: () => pluginIconFetchContext(this.context),
      isConnected: () => this.gateway.connected,
      onUrlsChange: (urls) => {
        this.state.clawhubIconUrls = urls;
      },
    });
    const agents = projectAgents(context.agents);
    const config = context.config ? projectApplicationConfig(context.config) : undefined;
    createEffect(
      () => agents.revision(),
      () => {
        this.reconcileAgentState();
        this.ensureInitialData();
        changed();
      },
    );
    createEffect(() => config?.revision(), changed);
    createEffect(
      () => this.agentSelection,
      (selection) => {
        const sync = () => {
          const previous = this.state.skillsAgentId;
          this.reconcileAgentState();
          if (this.routeDataInitialized && previous !== this.state.skillsAgentId) {
            this.routeDataEnabled = false;
            this.ensureInitialData();
          }
          changed();
        };
        const cleanup = selection.subscribe(sync);
        sync();
        return cleanup;
      },
    );
    createEffect(
      () => this.routeData,
      () => {
        this.applyRouteData();
        this.ensureInitialData();
      },
    );
    createEffect(
      () => [this.state.clawhubSearchResults, this.state.clawhubDetail] as const,
      () => {
        this.clawhubIcons.syncCatalog(
          [],
          [
            ...(this.state.clawhubSearchResults ?? []).flatMap((result) =>
              result.icon ? [result.icon] : [],
            ),
            ...(this.state.clawhubDetail?.skill?.icon ? [this.state.clawhubDetail.skill.icon] : []),
            ...(this.state.clawhubDetail?.owner?.image
              ? [this.state.clawhubDetail.owner.image]
              : []),
          ],
        );
      },
    );
    const searchContext = createMemo(
      () => [this.client, this.connected, this.gateway.epoch, this.surface] as const,
      { equals: (previous, next) => previous.every((value, index) => value === next[index]) },
    );
    createEffect(searchContext, ([, connected]) => {
      // Gateway binding may connect before the initial disconnected effect runs.
      if (connected) {
        void this.runSearch();
      }
    });
    onCleanup(() => {
      this.clearClawHubSearchTimer();
      this.searchAbort?.abort();
      this.searchGeneration++;
      this.clawhubIcons.reset();
    });
  }

  private async runSearch() {
    this.searchAbort?.abort();
    const generation = ++this.searchGeneration;
    this.state.clawhubSearchResults = null;
    this.state.clawhubSearchError = null;
    this.state.clawhubSearchLoading = this.connected && this.surface === "discovery";
    const client = this.client;
    if (!this.state.clawhubSearchLoading || !client || this.clawhubSearchTimer) {
      return;
    }
    const controller = (this.searchAbort = new AbortController());
    try {
      const results = await searchClawHub(client, this.state.clawhubSearchQuery, controller.signal);
      if (generation === this.searchGeneration) {
        this.state.clawhubSearchResults = results;
      }
    } catch (error) {
      if (generation === this.searchGeneration) {
        this.state.clawhubSearchError = formatUiError(error);
      }
    } finally {
      if (generation === this.searchGeneration) {
        this.state.clawhubSearchLoading = false;
      }
    }
  }

  private get agentSelection() {
    return this.surface === "settings"
      ? this.context.settingsAgentSelection
      : this.context.agentSelection;
  }

  private reconcileAgentState() {
    const agentState = this.context.agents.state;
    const previousAgentId = this.state.skillsAgentId;
    setSkillsAgentId(this.state, this.agentSelection.state.selectedId);
    if (this.surface === "discovery" && agentState.agentsList) {
      reconcileSkillsAgentId(this.state, agentState.agentsList);
    }
    if (previousAgentId !== this.state.skillsAgentId) {
      this.state.skillsDetailKey = null;
      this.state.skillsDetailTab = "overview";
      closeClawHubDetail(this.state);
    }
  }

  private resetLoadedSkillState() {
    this.library.reset();
    this.searchAbort?.abort();
    this.searchGeneration++;
    this.clearClawHubSearchTimer();
    this.state.clawhubSearchResults = null;
    this.state.clawhubSearchLoading = false;
    this.state.clawhubSearchError = null;
    if (this.routeDataInitialized) {
      this.routeDataEnabled = false;
    }
    Object.assign(this.state, createSkillsData(), {
      skillsAgentRevision: this.state.skillsAgentRevision + 1,
      skillsFilter: this.state.skillsFilter,
      skillsStatusFilter: this.state.skillsStatusFilter,
      clawhubSearchQuery: this.state.clawhubSearchQuery,
    });
    this.clawhubIcons.reset();
  }

  private applyRouteData() {
    const data = this.routeData;
    if (!data) {
      return;
    }
    this.routeDataInitialized = true;
    this.routeDataEnabled = true;
    if (!this.gateway.isRouteDataCurrent(data) || data.agents !== this.context.agents) {
      this.routeDataEnabled = false;
      return;
    }
    const selection = this.agentSelection.state;
    // A preload may finish after another explicit choice, including an A→B→A switch.
    if (this.agentSelection.intentRevision !== data.selectionIntentRevision) {
      this.routeDataEnabled = false;
      this.reconcileAgentState();
      return;
    }
    setSkillsAgentId(this.state, data.selectedAgentId);
    if (data.selectedAgentId && selection.selectedId !== data.selectedAgentId) {
      this.agentSelection.set(data.selectedAgentId);
    }
    this.reconcileAgentState();
    if (this.state.skillsAgentId !== data.selectedAgentId) {
      this.routeDataEnabled = false;
      return;
    }
    this.routeDataEnabled = true;
    this.state.skillsLoading = false;
    this.state.skillsReport = data.report;
    this.state.skillsError = data.error;
    if (data.report) {
      void loadClawHubSecurityVerdicts(this.state, data.report);
    }
    if (data.clawhubRef && data.clawhubRef !== this.state.clawhubDetailRef) {
      void loadClawHubDetail(this.state, data.clawhubRef);
    }
  }

  private ensureInitialData() {
    if (this.library && !this.library.list && !this.library.loading && !this.library.error) {
      void this.library.load();
    }
    if (
      this.routeDataEnabled ||
      !this.routeDataInitialized ||
      !this.gateway.connected ||
      !this.gateway.client
    ) {
      return;
    }
    const agents = this.context.agents.state;
    if (!agents.agentsList) {
      if (!agents.agentsLoading) {
        void this.loadAgents();
      }
      return;
    }
    this.reconcileAgentState();
    if (!this.state.skillsReport && !this.state.skillsLoading) {
      void loadSkills(this.state);
    }
  }

  private async loadAgents() {
    if (!this.gateway.client || !this.gateway.connected) {
      return;
    }
    const agentsSource = this.context.agents;
    if (!agentsSource.state.agentsList) {
      await agentsSource.ensureList();
    }
    if (this.context.agents === agentsSource) {
      this.reconcileAgentState();
      this.ensureInitialData();
    }
  }

  private async refreshPage() {
    await Promise.all([refreshSkills(this.state, () => this.loadAgents()), this.library.load()]);
  }

  private changeClawHubQuery(query: string) {
    this.state.clawhubSearchQuery = query;
    this.state.clawhubSearchResults = null;
    this.state.clawhubSearchError = null;
    this.state.clawhubSearchLoading = true;
    this.state.clawhubInstallMessage = null;
    this.clearClawHubSearchTimer();
    this.searchAbort?.abort();
    this.searchGeneration++;
    this.clawhubSearchTimer = setTimeout(() => {
      this.clawhubSearchTimer = null;
      void this.runSearch();
    }, 300);
  }

  private clearClawHubSearchTimer() {
    if (this.clawhubSearchTimer) {
      clearTimeout(this.clawhubSearchTimer);
      this.clawhubSearchTimer = null;
    }
  }

  private changeDetailTab(tab: SkillDetailTab) {
    this.state.skillsDetailTab = tab;
    if (tab === "card" && this.state.skillsDetailKey) {
      void loadSkillCard(this.state, this.state.skillsDetailKey);
    }
  }

  private canUpdateSkills(): boolean {
    return canCallGatewayMethod(this.gateway.snapshot, "skills.update", "operator.admin");
  }

  private canInstallSkills(): boolean {
    return canCallGatewayMethod(this.gateway.snapshot, "skills.install", "operator.admin");
  }

  private canInstallFromClawHub(): boolean {
    // The library owns the destination; a pending or failed first load is not workspace consent.
    return (
      this.library.list !== null &&
      !this.library.loading &&
      (this.library.showWorkspace
        ? this.canInstallSkills()
        : this.library.canWrite && Boolean(this.library.list.profileId))
    );
  }

  private navigateSkills(route: "skills" | "skill-settings") {
    this.context.navigate(route, {
      search: this.state.skillsAgentId
        ? `?agent=${encodeURIComponent(this.state.skillsAgentId)}`
        : "",
    });
  }

  render() {
    return (
      <>
        {this.surface === "discovery" ? (
          <PluginsHubHeader
            active="skills"
            onSelect={(tab) => {
              if (tab !== "skills") {
                this.context.navigate(tab);
              }
            }}
            secondaryAction={{
              label: t("skillDiscovery.settings"),
              icon: <Icon name="settings" />,
              onClick: () => this.navigateSkills("skill-settings"),
            }}
          />
        ) : (
          <SettingsPageHeader title={t("tabs.skills")} subtitle={t("subtitles.skills")} />
        )}
        <SettingsWorkspace>
          <div
            id={this.surface === "discovery" ? PLUGINS_HUB_PANEL_ID : undefined}
            role={this.surface === "discovery" ? "tabpanel" : undefined}
            aria-labelledby={this.surface === "discovery" ? "plugins-tab-skills" : undefined}
          >
            <Skills
              state={this.state}
              surface={this.surface}
              libraryEntries={this.library.list?.entries ?? []}
              onLibraryOpen={(skillId) => void this.library.open(skillId)}
              library={
                this.surface === "discovery" ? (
                  <>
                    <SkillLibraryFeedback library={this.library} />
                    <SkillLibraryDialogs library={this.library} />
                  </>
                ) : (
                  <SkillLibrary
                    library={this.library}
                    navigationActions={
                      <>
                        <button
                          type="button"
                          class="btn"
                          onClick={() => this.navigateSkills("skills")}
                        >
                          <Icon name="search" />
                          {t("skillDiscovery.search")}
                        </button>
                        <button
                          type="button"
                          class="btn"
                          onClick={() => this.context.navigate("skill-workshop")}
                        >
                          {t("pluginsPage.workshopTab")}
                        </button>
                      </>
                    }
                  />
                )
              }
              showInventory={this.library.showWorkspace}
              canUpdate={this.canUpdateSkills()}
              canInstall={this.canInstallFromClawHub()}
              loading={
                this.state.skillsLoading ||
                this.context.agents.state.agentsLoading ||
                this.library.busy
              }
              error={this.state.skillsError ?? this.context.agents.state.agentsError}
              onFilterChange={(next) => (this.state.skillsFilter = next)}
              onStatusFilterChange={(next) => (this.state.skillsStatusFilter = next)}
              onRefresh={() => void this.refreshPage()}
              onToggle={(key, enabled) => {
                if (this.canUpdateSkills()) {
                  void updateSkillEnabled(this.state, key, enabled, () => this.canUpdateSkills());
                }
              }}
              onEdit={(key, value) => {
                if (this.canUpdateSkills()) {
                  updateSkillEdit(this.state, key, value);
                }
              }}
              onSaveKey={(key) => {
                if (this.canUpdateSkills()) {
                  void saveSkillApiKey(this.state, key, () => this.canUpdateSkills());
                }
              }}
              onInstall={(skillKey, name, installId) => {
                if (this.canInstallSkills()) {
                  void installSkill(this.state, skillKey, name, installId);
                }
              }}
              onDetailOpen={(key) => {
                this.state.skillsDetailKey = key;
                this.state.skillsDetailTab = "overview";
              }}
              onDetailClose={() => (this.state.skillsDetailKey = null)}
              onDetailTabChange={(tab) => this.changeDetailTab(tab)}
              onClawHubQueryChange={(query) => this.changeClawHubQuery(query)}
              onClawHubDetailOpen={(ref) => void loadClawHubDetail(this.state, ref)}
              onClawHubDetailClose={() => closeClawHubDetail(this.state)}
              onClawHubInstall={(ref, version) => {
                if (!this.canInstallFromClawHub()) {
                  return;
                }
                if (!this.library.showWorkspace) {
                  this.state.clawhubDetailRef = null;
                  this.library.importSource = { slug: ref, version };
                  this.library.importSlug = "";
                  this.library.importOpen = true;
                  this.changed();
                } else {
                  void installFromClawHub(this.state, ref, version);
                }
              }}
            />
          </div>
        </SettingsWorkspace>
      </>
    );
  }
}

export type SkillsPageProps = { routeData?: SkillsRouteData; surface?: "discovery" | "settings" };

export const SkillsPage = defineSolidBridge<SkillsPageProps>(
  "openclaw-skills-page",
  (props) => {
    const [revision, setRevision] = createSignal(0, { ownedWrite: true });
    const state = new SkillsPageState(useApplication(), props, revision, () => {
      setRevision((value) => value + 1);
    });
    return state.render();
  },
  {
    properties: {
      routeData: { default: undefined, attribute: false },
      surface: { default: "settings", attribute: false },
    },
  },
);
