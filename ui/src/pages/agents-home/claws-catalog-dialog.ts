import { consume } from "@lit/context";
import type { PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { selectApplicationSession } from "../../app/agent-selection.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { registerAgentsHomeEnglish } from "../../i18n/locales/en-agents-home.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import {
  buildAgentMainSessionKey,
  resolveUiConfiguredMainKey,
} from "../../lib/sessions/session-key.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { hasCompleteClawDisclosures } from "./claws-access-review.ts";
import {
  applyOfficialClawAdd,
  planOfficialClawAdd,
  readClawStatus,
  readOfficialClawDetail,
  searchOfficialClaws,
  type ClawAddApplyResult,
  type ClawAddPlan,
  type ClawCatalogDetail,
  type ClawCatalogEntry,
  type ClawCatalogSource,
} from "./claws-catalog-client.ts";
import { renderClawsCatalogDialog } from "./claws-catalog-view.ts";
import { isRejectedClawMutation } from "./claws-mutation-error.ts";
import { pluginAcknowledgements } from "./claws-plugin-review.ts";
import { skillAcknowledgements } from "./claws-skill-review.ts";

registerAgentsHomeEnglish();

export class ClawsCatalogDialog extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) onClose?: () => void;
  @property({ attribute: false }) onAdded?: () => void;
  @property({ attribute: false }) initialEntry: ClawCatalogEntry | null = null;

  @state() private entries: ClawCatalogEntry[] = [];
  @state() private query = "";
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private selected: ClawCatalogEntry | null = null;
  @state() private detail: ClawCatalogDetail | null = null;
  @state() private plan: ClawAddPlan | null = null;
  @state() private reviewLoading = false;
  @state() private reviewError: string | null = null;
  @state() private applying = false;
  @state() private applyResult: ClawAddApplyResult | null = null;
  @state() private applyUnknown = false;
  @state() private statusChecking = false;
  @state() private setupChatError: string | null = null;
  @state() private riskAcknowledged = false;
  @state() private acceptedPluginRisks = new Set<string>();
  @state() private acceptedSkillWarnings = new Set<string>();

  private searchRevision = 0;
  private reviewRevision = 0;
  private setupChatRevision = 0;
  private applyResultGatewayUrl: string | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingApply: {
    agentId: string;
    packageName: string;
    version: string;
    gatewayUrl: string;
  } | null = null;
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    onIdentityChange: () => {
      this.entries = [];
      if (!this.pendingApply && !this.applyResult) {
        this.selected = null;
        this.detail = null;
        this.plan = null;
        this.applyResult = null;
        this.applyResultGatewayUrl = null;
      }
    },
    invalidateRequests: (change) => {
      this.searchRevision += 1;
      this.reviewRevision += 1;
      this.entries = [];
      this.error = change.snapshot.phase === "connected" ? null : t("clawsCatalog.unavailable");
      this.loading = false;
      this.reviewLoading = false;
      if (change.snapshot.phase !== "connected" && !this.pendingApply && !this.applyResult) {
        this.reviewError = t("clawsCatalog.unavailable");
      }
      if (this.pendingApply) {
        this.applyUnknown = true;
      }
      this.applying = false;
      this.statusChecking = false;
    },
    ensureInitialData: () => {
      if (this.initialEntry) {
        if (!this.pendingApply && !this.applyResult) {
          this.select(this.initialEntry);
        }
      } else {
        void this.loadCatalog();
      }
      if (this.applyUnknown) {
        void this.reconcileApply();
      }
    },
  });

  override updated(changedProperties: PropertyValues<this>) {
    if (
      changedProperties.has("initialEntry") &&
      this.initialEntry &&
      !this.pendingApply &&
      !this.applyResult &&
      (this.selected?.packageName !== this.initialEntry.packageName ||
        this.selected?.latestVersion !== this.initialEntry.latestVersion)
    ) {
      this.select(this.initialEntry);
    }
  }

  override disconnectedCallback() {
    this.setupChatRevision += 1;
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    super.disconnectedCallback();
  }

  private async loadCatalog() {
    if (this.initialEntry) {
      return;
    }
    const scope = this.gateway.capture();
    if (!scope) {
      return;
    }
    const revision = ++this.searchRevision;
    this.entries = [];
    this.loading = true;
    this.error = null;
    try {
      const entries = await searchOfficialClaws(scope.client, this.query);
      if (this.gateway.isCurrent(scope) && revision === this.searchRevision) {
        this.entries = entries;
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope) && revision === this.searchRevision) {
        this.error = formatUiError(error, t("clawsCatalog.unavailable"));
      }
    } finally {
      if (this.gateway.isCurrent(scope) && revision === this.searchRevision) {
        this.loading = false;
      }
    }
  }

  private search(query: string) {
    this.query = query;
    this.searchRevision += 1;
    this.entries = [];
    this.error = null;
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      void this.loadCatalog();
    }, 150);
  }

  private source(): ClawCatalogSource | null {
    const packageName = this.selected?.packageName;
    const version = this.selected?.latestVersion;
    return packageName && version ? { packageName, version } : null;
  }

  private async loadReview() {
    const source = this.source();
    const scope = this.gateway.capture();
    if (!source || !scope) {
      this.reviewError = t("clawsCatalog.noVersion");
      return;
    }
    const revision = ++this.reviewRevision;
    this.detail = null;
    this.plan = null;
    this.reviewError = null;
    this.reviewLoading = true;
    this.riskAcknowledged = false;
    this.acceptedPluginRisks = new Set();
    this.acceptedSkillWarnings = new Set();
    try {
      const detail = await readOfficialClawDetail(scope.client, source);
      if (!this.gateway.isCurrent(scope) || revision !== this.reviewRevision) {
        return;
      }
      this.detail = detail;
      const plan = await planOfficialClawAdd(scope.client, source);
      if (this.gateway.isCurrent(scope) && revision === this.reviewRevision) {
        this.plan = plan;
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope) && revision === this.reviewRevision) {
        this.reviewError = formatUiError(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope) && revision === this.reviewRevision) {
        this.reviewLoading = false;
      }
    }
  }

  private select(entry: ClawCatalogEntry) {
    this.selected = entry;
    this.applyResult = null;
    this.applyResultGatewayUrl = null;
    this.setupChatError = null;
    void this.loadReview();
  }

  private close() {
    this.setupChatRevision += 1;
    this.onClose?.();
  }

  private back() {
    if (this.applying || this.applyUnknown || this.applyResult) {
      return;
    }
    if (this.initialEntry) {
      this.close();
      return;
    }
    this.reviewRevision += 1;
    this.selected = null;
    this.detail = null;
    this.plan = null;
    this.reviewError = null;
    this.applyResult = null;
    this.applyResultGatewayUrl = null;
    this.setupChatError = null;
    this.reviewLoading = false;
  }

  private openAgentChat(agentId: string, context: ApplicationContext) {
    const mainKey =
      resolveUiConfiguredMainKey({
        agentsList: context.agents.state.agentsList,
        hello: context.gateway.snapshot.hello,
      }) ?? "main";
    const sessionKey = buildAgentMainSessionKey({ agentId, mainKey });
    const target = sessionNavigationTarget({
      context,
      face: "chat",
      sessionKey,
      agentId,
    });
    selectApplicationSession({
      selection: context.agentSelection,
      gateway: context.gateway,
      sessionKey,
      agentId,
    });
    this.close();
    context.navigate("chat", target.options);
  }

  private async openSetupChat() {
    const result = this.applyResult;
    const resultGatewayUrl = this.applyResultGatewayUrl;
    const source = this.source();
    const scope = this.gateway.capture();
    const context = this.context;
    if (
      !result ||
      result.status !== "complete" ||
      result.readiness.ready ||
      !source ||
      !scope ||
      !resultGatewayUrl ||
      this.applying ||
      this.statusChecking
    ) {
      return;
    }
    if (context.gateway.connection.gatewayUrl !== resultGatewayUrl) {
      this.setupChatError = t("clawsCatalog.setupChatUnavailable");
      return;
    }
    const revision = this.setupChatRevision;
    this.statusChecking = true;
    this.setupChatError = null;
    try {
      const roster = await context.agents.refreshList().catch(() => undefined);
      if (
        !this.gateway.isCurrent(scope) ||
        revision !== this.setupChatRevision ||
        this.context !== context ||
        this.applyResult !== result ||
        this.applyResultGatewayUrl !== resultGatewayUrl ||
        context.gateway.connection.gatewayUrl !== resultGatewayUrl
      ) {
        return;
      }
      if (!roster?.agents.some((agent) => agent.id === result.agentId)) {
        this.setupChatError = t("clawsCatalog.setupChatUnavailable");
        return;
      }
      const record = await readClawStatus(scope.client, result.agentId).catch(() => null);
      if (
        !this.gateway.isCurrent(scope) ||
        revision !== this.setupChatRevision ||
        this.context !== context ||
        this.applyResult !== result ||
        this.applyResultGatewayUrl !== resultGatewayUrl ||
        context.gateway.connection.gatewayUrl !== resultGatewayUrl
      ) {
        return;
      }
      if (
        record?.name !== source.packageName ||
        record.version !== source.version ||
        record.sourceKind !== "package" ||
        record.status !== "complete" ||
        record.agentState !== "present"
      ) {
        this.setupChatError = t("clawsCatalog.setupChatUnavailable");
        return;
      }
      this.statusChecking = false;
      this.openAgentChat(result.agentId, context);
    } finally {
      if (this.gateway.isCurrent(scope) && revision === this.setupChatRevision) {
        this.statusChecking = false;
      }
    }
  }

  private async reconcileApply() {
    const pending = this.pendingApply;
    const scope = this.gateway.capture();
    const context = this.context;
    if (
      !pending?.agentId ||
      !scope ||
      this.statusChecking ||
      context.gateway.connection.gatewayUrl !== pending.gatewayUrl
    ) {
      return;
    }
    this.statusChecking = true;
    try {
      const record = await readClawStatus(scope.client, pending.agentId);
      if (!this.gateway.isCurrent(scope) || this.pendingApply !== pending) {
        return;
      }
      if (
        record?.name !== pending.packageName ||
        record.sourceKind !== "package" ||
        record.version !== pending.version
      ) {
        return;
      }
      this.applyResult = {
        agentId: record.agentId,
        status: record.status,
        readiness: this.plan?.readiness ?? { ready: false, requirements: [] },
      };
      this.applyResultGatewayUrl = pending.gatewayUrl;
      this.applyUnknown = false;
      this.pendingApply = null;
      await context.agents.refreshList();
      this.onAdded?.();
    } catch {
      // A failed status read leaves the outcome unknown; it must not permit another Add.
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.statusChecking = false;
      }
    }
  }

  private async add() {
    const source = this.source();
    const plan = this.plan;
    const scope = this.gateway.capture();
    const acknowledgeCapabilities = plan
      ? pluginAcknowledgements(plan.pluginReviews, this.acceptedPluginRisks)
      : null;
    const acknowledgeSkillWarnings = plan
      ? skillAcknowledgements(plan.skillReviews, this.acceptedSkillWarnings)
      : null;
    if (
      !source ||
      !plan ||
      !scope ||
      !this.canAdd() ||
      this.applying ||
      this.applyUnknown ||
      this.applyResult ||
      plan.blockers.length > 0 ||
      plan.actions.some((action) => action.blocked) ||
      !hasCompleteClawDisclosures(plan) ||
      (plan.riskAcknowledgementRequired && !this.riskAcknowledged) ||
      !acknowledgeCapabilities ||
      !acknowledgeSkillWarnings
    ) {
      return;
    }
    const revision = this.reviewRevision;
    const context = this.context;
    const pending = {
      agentId: plan.target.agentId ?? "",
      packageName: source.packageName,
      version: source.version,
      gatewayUrl: context.gateway.connection.gatewayUrl,
    };
    this.pendingApply = pending;
    this.applying = true;
    this.reviewError = null;
    this.setupChatError = null;
    try {
      const result = await applyOfficialClawAdd(
        scope.client,
        source,
        plan,
        this.riskAcknowledged,
        acknowledgeCapabilities,
        acknowledgeSkillWarnings,
      );
      if (
        !this.gateway.isCurrent(scope) ||
        revision !== this.reviewRevision ||
        this.context !== context
      ) {
        return;
      }
      this.pendingApply = null;
      this.applyUnknown = false;
      this.applyResult = result;
      this.applyResultGatewayUrl = pending.gatewayUrl;
      // The Add result is known even when refreshing the roster fails.
      const roster = await context.agents.refreshList().catch(() => undefined);
      if (
        !this.gateway.isCurrent(scope) ||
        revision !== this.reviewRevision ||
        this.context !== context
      ) {
        return;
      }
      this.onAdded?.();
      if (result.status === "complete" && result.readiness.ready) {
        if (!roster?.agents.some((agent) => agent.id === result.agentId)) {
          return;
        }
        const record = await readClawStatus(scope.client, result.agentId).catch(() => null);
        if (
          !this.gateway.isCurrent(scope) ||
          revision !== this.reviewRevision ||
          this.context !== context ||
          record?.name !== source.packageName ||
          record?.version !== source.version ||
          record.sourceKind !== "package" ||
          record.status !== "complete" ||
          record.agentState !== "present"
        ) {
          return;
        }
        this.openAgentChat(result.agentId, context);
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope) && revision === this.reviewRevision) {
        if (!this.applyResult) {
          if (isRejectedClawMutation(error)) {
            this.pendingApply = null;
            this.plan = null;
            this.reviewError = formatUiError(error);
          } else {
            this.applyUnknown = true;
            void this.reconcileApply();
          }
        }
      }
    } finally {
      if (this.gateway.isCurrent(scope) && revision === this.reviewRevision) {
        this.applying = false;
      }
    }
  }

  private canAdd() {
    return canCallGatewayMethod(this.gateway.snapshot, "claws.add.apply", "operator.admin");
  }

  override render() {
    return renderClawsCatalogDialog({
      entries: this.entries,
      query: this.query,
      loading: this.loading,
      error: this.error,
      selected: this.selected,
      detail: this.detail,
      plan: this.plan,
      reviewLoading: this.reviewLoading,
      reviewError: this.reviewError,
      applying: this.applying,
      applyResult: this.applyResult,
      applyUnknown: this.applyUnknown,
      statusChecking: this.statusChecking,
      setupChatError: this.setupChatError,
      riskAcknowledged: this.riskAcknowledged,
      acceptedPluginRisks: this.acceptedPluginRisks,
      acceptedSkillWarnings: this.acceptedSkillWarnings,
      canAdd: this.canAdd(),
      onSearch: (query) => this.search(query),
      onSelect: (entry) => this.select(entry),
      onBack: () => this.back(),
      onClose: () => this.close(),
      onRetryCatalog: () => void this.loadCatalog(),
      onRetryReview: () => void this.loadReview(),
      onRiskAcknowledged: (checked) => (this.riskAcknowledged = checked),
      onPluginRiskAcknowledged: (key, checked) => {
        const accepted = new Set(this.acceptedPluginRisks);
        if (checked) {
          accepted.add(key);
        } else {
          accepted.delete(key);
        }
        this.acceptedPluginRisks = accepted;
      },
      onSkillRiskAcknowledged: (key, checked) => {
        const accepted = new Set(this.acceptedSkillWarnings);
        if (checked) {
          accepted.add(key);
        } else {
          accepted.delete(key);
        }
        this.acceptedSkillWarnings = accepted;
      },
      onConfirm: () => void this.add(),
      onCheckStatus: () => void this.reconcileApply(),
      onOpenSetupChat: () => void this.openSetupChat(),
    });
  }
}

if (!customElements.get("openclaw-claws-catalog-dialog")) {
  customElements.define("openclaw-claws-catalog-dialog", ClawsCatalogDialog);
}
