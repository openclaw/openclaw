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
import { searchClawHub, type ClawHubSearchResult } from "../../lib/skills/clawhub-search.ts";
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
  type ClawHubSkillDetail,
  type ClawHubSkillSecurityVerdict,
  type SkillOperation,
  type SkillMessageMap,
} from "../../lib/skills/index.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { PluginIconController, pluginIconFetchContext } from "../plugins/plugin-icon-controller.ts";
import { PluginsHubHeader } from "../plugins/plugins-hub-header.tsx";
import { PLUGINS_HUB_PANEL_ID } from "../plugins/plugins-hub.ts";
import { SkillLibraryController } from "./library-controller.ts";
import { SkillLibrary, SkillLibraryDialogs, SkillLibraryFeedback } from "./library-view.tsx";
import type { SkillDetailTab, SkillsStatusFilter } from "./view-types.ts";
import { Skills } from "./view.tsx";

const STATE_FIELDS = [
  "skillsAgentId",
  "skillsAgentRevision",
  "skillsLoading",
  "skillsReport",
  "skillsError",
  "skillOperation",
  "skillsFilter",
  "skillsStatusFilter",
  "skillEdits",
  "skillMessages",
  "skillsDetailKey",
  "skillsDetailTab",
  "clawhubSearchQuery",
  "clawhubDetail",
  "clawhubDetailRef",
  "clawhubDetailLoading",
  "clawhubDetailError",
  "clawhubInstallMessage",
  "clawhubVerdicts",
  "clawhubVerdictsLoading",
  "clawhubVerdictsError",
  "skillCardContents",
  "skillCardContentKeys",
  "skillCardLoadingKey",
  "skillCardErrors",
  "clawhubIconUrls",
  "clawhubSearchResults",
  "clawhubSearchLoading",
  "clawhubSearchError",
] as const;

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

  skillsAgentId: string | null = null;
  skillsAgentRevision = 0;
  skillsLoading = false;
  skillsReport: SkillStatusReport | null = null;
  skillsError: string | null = null;
  skillOperation: SkillOperation = null;
  skillsFilter = "";
  skillsStatusFilter: SkillsStatusFilter = "all";
  skillEdits: Record<string, string> = {};
  skillMessages: SkillMessageMap = {};
  skillsDetailKey: string | null = null;
  skillsDetailTab: SkillDetailTab = "overview";
  clawhubSearchQuery = "";
  clawhubDetail: ClawHubSkillDetail | null = null;
  clawhubDetailRef: string | null = null;
  clawhubDetailLoading = false;
  clawhubDetailError: string | null = null;
  clawhubInstallMessage: {
    kind: "success" | "error";
    text: string;
  } | null = null;
  clawhubVerdicts: Record<string, ClawHubSkillSecurityVerdict> = {};
  clawhubVerdictsLoading = false;
  clawhubVerdictsError: string | null = null;
  skillCardContents: Record<string, string> = {};
  skillCardContentKeys: Record<string, string> = {};
  skillCardLoadingKey: string | null = null;
  skillCardErrors: Record<string, string> = {};
  clawhubIconUrls: Record<string, string> = {};

  get runtimeConfig(): ApplicationContext["runtimeConfig"] {
    return this.context.runtimeConfig;
  }

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
  clawhubSearchResults: ClawHubSearchResult[] | null = null;
  clawhubSearchLoading = false;
  clawhubSearchError: string | null = null;

  constructor(
    readonly context: ApplicationContext,
    readonly props: SkillsPageProps,
    readonly revision: () => number,
    readonly changed: () => void,
  ) {
    // Domain methods retain synchronous mutation; the signal only publishes a view revision.
    for (const key of STATE_FIELDS) {
      let value = Reflect.get(this, key);
      Object.defineProperty(this, key, {
        get: () => {
          revision();
          return value;
        },
        set: (next) => {
          if (Object.is(value, next)) {
            return;
          }
          value = next;
          changed();
        },
      });
    }
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
        this.clawhubIconUrls = urls;
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
          const previous = this.skillsAgentId;
          this.reconcileAgentState();
          if (this.routeDataInitialized && previous !== this.skillsAgentId) {
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
      () => [this.clawhubSearchResults, this.clawhubDetail] as const,
      () => {
        this.clawhubIcons.syncCatalog(
          [],
          [
            ...(this.clawhubSearchResults ?? []).flatMap((result) =>
              result.icon ? [result.icon] : [],
            ),
            ...(this.clawhubDetail?.skill?.icon ? [this.clawhubDetail.skill.icon] : []),
            ...(this.clawhubDetail?.owner?.image ? [this.clawhubDetail.owner.image] : []),
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
    this.clawhubSearchResults = null;
    this.clawhubSearchError = null;
    this.clawhubSearchLoading = this.connected && this.surface === "discovery";
    const client = this.client;
    if (!this.clawhubSearchLoading || !client || this.clawhubSearchTimer) {
      return;
    }
    const controller = (this.searchAbort = new AbortController());
    try {
      const results = await searchClawHub(client, this.clawhubSearchQuery, controller.signal);
      if (generation === this.searchGeneration) {
        this.clawhubSearchResults = results;
      }
    } catch (error) {
      if (generation === this.searchGeneration) {
        this.clawhubSearchError = formatUiError(error);
      }
    } finally {
      if (generation === this.searchGeneration) {
        this.clawhubSearchLoading = false;
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
    const previousAgentId = this.skillsAgentId;
    setSkillsAgentId(this, this.agentSelection.state.selectedId);
    if (this.surface === "discovery" && agentState.agentsList) {
      reconcileSkillsAgentId(this, agentState.agentsList);
    }
    if (previousAgentId !== this.skillsAgentId) {
      this.skillsDetailKey = null;
      this.skillsDetailTab = "overview";
      closeClawHubDetail(this);
    }
  }

  private resetLoadedSkillState() {
    this.library.reset();
    this.searchAbort?.abort();
    this.searchGeneration++;
    this.clearClawHubSearchTimer();
    this.clawhubSearchResults = null;
    this.clawhubSearchLoading = false;
    this.clawhubSearchError = null;
    if (this.routeDataInitialized) {
      this.routeDataEnabled = false;
    }
    this.skillsAgentId = null;
    this.skillsAgentRevision++;
    this.skillsLoading = false;
    this.skillsReport = null;
    this.skillsError = null;
    this.skillOperation = null;
    this.skillEdits = {};
    this.skillMessages = {};
    this.skillsDetailKey = null;
    this.skillsDetailTab = "overview";
    this.clawhubDetail = null;
    this.clawhubDetailRef = null;
    this.clawhubDetailLoading = false;
    this.clawhubDetailError = null;
    this.clawhubInstallMessage = null;
    this.clawhubVerdicts = {};
    this.clawhubVerdictsLoading = false;
    this.clawhubVerdictsError = null;
    this.skillCardContents = {};
    this.skillCardContentKeys = {};
    this.skillCardLoadingKey = null;
    this.skillCardErrors = {};
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
    setSkillsAgentId(this, data.selectedAgentId);
    if (data.selectedAgentId && selection.selectedId !== data.selectedAgentId) {
      this.agentSelection.set(data.selectedAgentId);
    }
    this.reconcileAgentState();
    if (this.skillsAgentId !== data.selectedAgentId) {
      this.routeDataEnabled = false;
      return;
    }
    this.routeDataEnabled = true;
    this.skillsLoading = false;
    this.skillsReport = data.report;
    this.skillsError = data.error;
    if (data.report) {
      void loadClawHubSecurityVerdicts(this, data.report);
    }
    if (data.clawhubRef && data.clawhubRef !== this.clawhubDetailRef) {
      void loadClawHubDetail(this, data.clawhubRef);
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
    if (!this.skillsReport && !this.skillsLoading) {
      void loadSkills(this);
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
    await Promise.all([refreshSkills(this, () => this.loadAgents()), this.library.load()]);
  }

  private changeClawHubQuery(query: string) {
    this.clawhubSearchQuery = query;
    this.clawhubSearchResults = null;
    this.clawhubSearchError = null;
    this.clawhubSearchLoading = true;
    this.clawhubInstallMessage = null;
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
    this.skillsDetailTab = tab;
    if (tab === "card" && this.skillsDetailKey) {
      void loadSkillCard(this, this.skillsDetailKey);
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
      search: this.skillsAgentId ? `?agent=${encodeURIComponent(this.skillsAgentId)}` : "",
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
              state={this}
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
                this.skillsLoading || this.context.agents.state.agentsLoading || this.library.busy
              }
              error={this.skillsError ?? this.context.agents.state.agentsError}
              onFilterChange={(next) => (this.skillsFilter = next)}
              onStatusFilterChange={(next) => (this.skillsStatusFilter = next)}
              onRefresh={() => void this.refreshPage()}
              onToggle={(key, enabled) => {
                if (this.canUpdateSkills()) {
                  void updateSkillEnabled(this, key, enabled, () => this.canUpdateSkills());
                }
              }}
              onEdit={(key, value) => {
                if (this.canUpdateSkills()) {
                  updateSkillEdit(this, key, value);
                }
              }}
              onSaveKey={(key) => {
                if (this.canUpdateSkills()) {
                  void saveSkillApiKey(this, key, () => this.canUpdateSkills());
                }
              }}
              onInstall={(skillKey, name, installId) => {
                if (this.canInstallSkills()) {
                  void installSkill(this, skillKey, name, installId);
                }
              }}
              onDetailOpen={(key) => {
                this.skillsDetailKey = key;
                this.skillsDetailTab = "overview";
              }}
              onDetailClose={() => (this.skillsDetailKey = null)}
              onDetailTabChange={(tab) => this.changeDetailTab(tab)}
              onClawHubQueryChange={(query) => this.changeClawHubQuery(query)}
              onClawHubDetailOpen={(ref) => void loadClawHubDetail(this, ref)}
              onClawHubDetailClose={() => closeClawHubDetail(this)}
              onClawHubInstall={(ref, version) => {
                if (!this.canInstallFromClawHub()) {
                  return;
                }
                if (!this.library.showWorkspace) {
                  this.clawhubDetailRef = null;
                  this.library.importSource = { slug: ref, version };
                  this.library.importSlug = "";
                  this.library.importOpen = true;
                  this.changed();
                } else {
                  void installFromClawHub(this, ref, version);
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
