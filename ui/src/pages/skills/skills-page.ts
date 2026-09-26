import { consume } from "@lit/context";
import { initialState, Task, TaskStatus } from "@lit/task";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { SkillStatusReport } from "../../api/types.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { icons } from "../../components/icons.ts";
import { renderSettingsPageHeader } from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
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
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { PluginIconController } from "../plugins/plugin-icon-controller.ts";
import { renderPluginsHubHeader } from "../plugins/plugins-hub-header.ts";
import { PLUGINS_HUB_PANEL_ID, type PluginsHubTab } from "../plugins/plugins-hub.ts";
import { SkillLibraryController } from "./library-controller.ts";
import { renderSkillLibrary, renderSkillLibraryDialogs } from "./library-view.ts";
import type { SkillDetailTab, SkillsStatusFilter } from "./view-types.ts";
import { renderSkills } from "./view.ts";

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

class SkillsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) routeData?: SkillsRouteData;
  @property({ attribute: false }) surface: "discovery" | "settings" = "settings";

  @state() skillsAgentId: string | null = null;
  @state() skillsAgentRevision = 0;
  @state() skillsLoading = false;
  @state() skillsReport: SkillStatusReport | null = null;
  @state() skillsError: string | null = null;
  @state() skillOperation: SkillOperation = null;
  @state() skillsFilter = "";
  @state() skillsStatusFilter: SkillsStatusFilter = "all";
  @state() skillEdits: Record<string, string> = {};
  @state() skillMessages: SkillMessageMap = {};
  @state() skillsDetailKey: string | null = null;
  @state() skillsDetailTab: SkillDetailTab = "overview";
  @state() clawhubSearchQuery = "";
  @state() clawhubDetail: ClawHubSkillDetail | null = null;
  @state() clawhubDetailRef: string | null = null;
  @state() clawhubDetailLoading = false;
  @state() clawhubDetailError: string | null = null;
  @state() clawhubInstallMessage: {
    kind: "success" | "error";
    text: string;
  } | null = null;
  @state() clawhubVerdicts: Record<string, ClawHubSkillSecurityVerdict> = {};
  @state() clawhubVerdictsLoading = false;
  @state() clawhubVerdictsError: string | null = null;
  @state() skillCardContents: Record<string, string> = {};
  @state() skillCardContentKeys: Record<string, string> = {};
  @state() skillCardLoadingKey: string | null = null;
  @state() skillCardErrors: Record<string, string> = {};
  @state() clawhubIconUrls: Record<string, string> = {};

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
  private debouncedClawHubSearchQuery = "";
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => this.resetLoadedSkillState(),
    ensureInitialData: () => this.ensureInitialData(),
  });
  private readonly clawhubIcons = new PluginIconController({
    kind: "catalog",
    getFetchContext: () => ({
      resourceBasePath: this.context.resourceBasePath,
      gatewayUrl: this.context.gateway.connection.gatewayUrl,
      auth: {
        hello: this.context.gateway.snapshot.hello,
        settings: { token: this.context.gateway.connection.token },
        password: this.context.gateway.connection.password,
      },
    }),
    isConnected: () => this.gateway.connected,
    onUrlsChange: (urls) => {
      this.clawhubIconUrls = urls;
    },
  });
  private readonly library = new SkillLibraryController(
    this,
    this.gateway,
    () => this.skillsAgentId,
    () => this.refreshPage(),
  );
  private readonly clawhubSearchTask = new Task(this, {
    args: () =>
      [
        this.gateway.connected && !this.clawhubSearchTimer && this.surface === "discovery"
          ? this.gateway.client
          : null,
        this.debouncedClawHubSearchQuery,
        this.gateway.epoch,
      ] as const,
    task: ([client, query], { signal }) =>
      client ? searchClawHub(client, query, signal) : initialState,
  });
  private readonly subscriptions = new SubscriptionsController(this)
    .effect(
      () => this.context?.agents,
      (agents) => {
        const cleanup = agents.subscribe(() => {
          this.reconcileAgentState();
          this.ensureInitialData();
          this.requestUpdate();
        });
        this.reconcileAgentState();
        this.ensureInitialData();
        return cleanup;
      },
    )
    .watch(
      () => this.context && this.agentSelection,
      (selection, notify) => selection.subscribe(notify),
      () => {
        const previous = this.skillsAgentId;
        this.reconcileAgentState();
        if (this.routeDataInitialized && previous !== this.skillsAgentId) {
          this.routeDataEnabled = false;
          this.ensureInitialData();
        }
      },
    );

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("routeData")) {
      this.applyRouteData();
      this.ensureInitialData();
    }
  }

  override updated() {
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
  }

  override disconnectedCallback() {
    this.subscriptions.clear();
    if (this.clawhubSearchTimer) {
      clearTimeout(this.clawhubSearchTimer);
      this.clawhubSearchTimer = null;
    }
    this.clawhubIcons.reset();
    super.disconnectedCallback();
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
    this.clawhubSearchTask.abort();
    if (this.clawhubSearchTimer) {
      clearTimeout(this.clawhubSearchTimer);
      this.clawhubSearchTimer = null;
    }
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
    this.debouncedClawHubSearchQuery = this.clawhubSearchQuery.trim();
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
    this.clawhubInstallMessage = null;
    if (this.clawhubSearchTimer) {
      clearTimeout(this.clawhubSearchTimer);
    }
    this.clawhubSearchTimer = setTimeout(() => {
      this.clawhubSearchTimer = null;
      this.debouncedClawHubSearchQuery = query.trim();
      this.requestUpdate();
    }, 300);
    this.requestUpdate();
  }

  get clawhubSearchResults(): ClawHubSearchResult[] | null {
    return this.clawhubSearchTask.status === TaskStatus.COMPLETE &&
      this.debouncedClawHubSearchQuery === this.clawhubSearchQuery.trim()
      ? (this.clawhubSearchTask.value ?? null)
      : null;
  }

  get clawhubSearchLoading(): boolean {
    return this.clawhubSearchTimer !== null || this.clawhubSearchTask.status === TaskStatus.PENDING;
  }

  get clawhubSearchError(): string | null {
    if (
      this.clawhubSearchTask.status !== TaskStatus.ERROR ||
      this.debouncedClawHubSearchQuery !== this.clawhubSearchQuery.trim()
    ) {
      return null;
    }
    const error = this.clawhubSearchTask.error;
    return formatUiError(error);
  }

  private changeDetailTab(tab: SkillDetailTab) {
    this.skillsDetailTab = tab;
    if (tab === "card" && this.skillsDetailKey) {
      void loadSkillCard(this, this.skillsDetailKey);
    }
  }

  private canUpdateSkills(): boolean {
    return canCallGatewayMethod(this.context?.gateway?.snapshot, "skills.update", "operator.admin");
  }

  private canInstallSkills(): boolean {
    return canCallGatewayMethod(
      this.context?.gateway?.snapshot,
      "skills.install",
      "operator.admin",
    );
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

  private selectHubTab(tab: PluginsHubTab) {
    if (tab === "skills") {
      return;
    }
    this.context.navigate(tab);
  }

  override render() {
    const agents = this.context.agents.state;
    const error = this.skillsError ?? agents.agentsError;
    return html`
      ${
        this.surface === "discovery"
          ? renderPluginsHubHeader({
              active: "skills",
              onSelect: (tab) => this.selectHubTab(tab),
              secondaryAction: {
                label: t("skillDiscovery.settings"),
                icon: icons.settings,
                onClick: () =>
                  this.context.navigate("skill-settings", {
                    search: this.skillsAgentId
                      ? `?agent=${encodeURIComponent(this.skillsAgentId)}`
                      : "",
                  }),
              },
            })
          : renderSettingsPageHeader({
              title: titleForRoute("skill-settings"),
              subtitle: subtitleForRoute("skill-settings"),
            })
      }
      ${renderSettingsWorkspace(html`
        <div
          id=${this.surface === "discovery" ? PLUGINS_HUB_PANEL_ID : nothing}
          role=${this.surface === "discovery" ? "tabpanel" : nothing}
          aria-labelledby=${this.surface === "discovery" ? "plugins-tab-skills" : nothing}
        >
          ${renderSkills({
            state: this,
            surface: this.surface,
            libraryEntries: this.library.list?.entries ?? [],
            onLibraryOpen: (skillId) => void this.library.open(skillId),
            library:
              this.surface === "discovery"
                ? html`
                    ${this.library.error && !this.library.draft && !this.library.importOpen ? html`<div class="callout danger" role="alert">${this.library.error}</div>` : nothing}
                    ${this.library.notice && !this.library.draft ? html`<div class="callout success" role="status">${this.library.notice}</div>` : nothing}
                    ${renderSkillLibraryDialogs(this.library)}
                  `
                : renderSkillLibrary(
                    this.library,
                    html`
                      <button
                        type="button"
                        class="btn"
                        @click=${() =>
                          this.context.navigate("skills", {
                            search: this.skillsAgentId
                              ? `?agent=${encodeURIComponent(this.skillsAgentId)}`
                              : "",
                          })}
                      >
                        ${icons.search} ${t("skillDiscovery.search")}
                      </button>
                      <button
                        type="button"
                        class="btn"
                        @click=${() => this.context.navigate("skill-workshop")}
                      >
                        ${t("pluginsPage.workshopTab")}
                      </button>
                    `,
                  ),
            showInventory: this.library.showWorkspace,
            canUpdate: this.canUpdateSkills(),
            canInstall: this.canInstallFromClawHub(),
            loading: this.skillsLoading || agents.agentsLoading || this.library.busy,
            error,
            onFilterChange: (next) => (this.skillsFilter = next),
            onStatusFilterChange: (next) => (this.skillsStatusFilter = next),
            onRefresh: () => void this.refreshPage(),
            onToggle: (key, enabled) => {
              if (this.canUpdateSkills()) {
                void updateSkillEnabled(this, key, enabled, () => this.canUpdateSkills());
              }
            },
            onEdit: (key, value) => {
              if (this.canUpdateSkills()) {
                updateSkillEdit(this, key, value);
              }
            },
            onSaveKey: (key) => {
              if (this.canUpdateSkills()) {
                void saveSkillApiKey(this, key, () => this.canUpdateSkills());
              }
            },
            onInstall: (skillKey, name, installId) => {
              if (this.canInstallSkills()) {
                void installSkill(this, skillKey, name, installId);
              }
            },
            onDetailOpen: (key) => {
              this.skillsDetailKey = key;
              this.skillsDetailTab = "overview";
            },
            onDetailClose: () => (this.skillsDetailKey = null),
            onDetailTabChange: (tab) => this.changeDetailTab(tab),
            onClawHubQueryChange: (query) => this.changeClawHubQuery(query),
            onClawHubDetailOpen: (ref) => void loadClawHubDetail(this, ref),
            onClawHubDetailClose: () => closeClawHubDetail(this),
            onClawHubInstall: (ref, version) => {
              if (!this.canInstallFromClawHub()) {
                return;
              }
              if (!this.library.showWorkspace) {
                this.clawhubDetailRef = null;
                this.library.importSource = { slug: ref, version };
                this.library.importSlug = "";
                this.library.importOpen = true;
                this.requestUpdate();
              } else {
                void installFromClawHub(this, ref, version);
              }
            },
          })}
        </div>
      `)}
    `;
  }
}

if (!customElements.get("openclaw-skills-page")) {
  customElements.define("openclaw-skills-page", SkillsPage);
}
