import { consume } from "@lit/context";
import type { PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { registerAgentsHomeEnglish } from "../../i18n/locales/en-agents-home.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { readClawStatus, type ClawStatusRecord } from "../agents-home/claws-catalog-client.ts";
import { isRejectedClawMutation } from "../agents-home/claws-mutation-error.ts";
import { LAB_FEATURES, resolveLabFeatureState } from "../labs/labs-registry.ts";
import {
  applyClawRemoval,
  planClawRemoval,
  type ClawLifecyclePlan,
  type ClawRemoveResult,
} from "./claw-lifecycle-client.ts";
import { renderAgentClawPanel } from "./claw-lifecycle-view.ts";
import { ClawUpdateController } from "./claw-update-controller.ts";

registerAgentsHomeEnglish();

const clawsLab = LAB_FEATURES.find((feature) => feature.id === "claws");

type PendingRemove = {
  agentId: string;
  gatewayUrl: string;
  agentWasMissing: boolean;
  agentRetainedByPlan: boolean;
};

export class AgentClawPanel extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) agentId = "";
  @property({ attribute: false }) onRemoved?: (agentId: string) => void;
  @property({ attribute: false }) onRemovePendingChange?: (
    agentId: string,
    pending: boolean,
  ) => void;

  @state() private record: ClawStatusRecord | null = null;
  @state() private statusLoading = false;
  @state() private statusError: string | null = null;
  @state() private reviewOpen = false;
  @state() private plan: ClawLifecyclePlan | null = null;
  @state() private planLoading = false;
  @state() private planError: string | null = null;
  @state() private removing = false;
  @state() private removeResult: ClawRemoveResult | null = null;
  @state() private removeUnknown = false;
  @state() private statusChecking = false;

  private statusRevision = 0;
  private planRevision = 0;
  private statusAgentId = "";
  private pendingRemove: PendingRemove | null = null;

  constructor() {
    super();
    new SubscriptionsController(this).effect(
      () => this.context?.runtimeConfig,
      (runtimeConfig) => {
        void runtimeConfig.ensureLoaded();
        return runtimeConfig.subscribe(() => this.requestUpdate());
      },
    );
  }

  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    onIdentityChange: () => {
      this.record = null;
      this.plan = null;
      if (
        !this.pendingRemove ||
        this.pendingRemove.gatewayUrl !== this.context.gateway.connection.gatewayUrl
      ) {
        this.setPendingRemove(null);
        this.removeUnknown = false;
        this.removeResult = null;
        this.reviewOpen = false;
      }
      this.clawUpdate.onGatewayIdentityChange(this.context.gateway.connection.gatewayUrl);
    },
    invalidateRequests: () => {
      this.statusRevision += 1;
      this.planRevision += 1;
      this.statusLoading = false;
      this.planLoading = false;
      this.statusChecking = false;
      if (this.pendingRemove) {
        this.removeUnknown = true;
      }
      this.removing = false;
      this.clawUpdate.invalidateRequests();
    },
    ensureInitialData: () => {
      void this.loadStatus();
      if (this.removeUnknown) {
        void this.reconcileRemove();
      }
      if (this.clawUpdate.unknown) {
        void this.clawUpdate.reconcile();
      }
    },
  });

  private readonly clawUpdate = new ClawUpdateController(this, this.gateway, {
    getRecord: () => this.record,
    setRecord: (record) => (this.record = record),
    getGatewayUrl: () => this.context.gateway.connection.gatewayUrl,
    canUpdate: () => this.canUpdate(),
    loadStatus: () => void this.loadStatus(),
  });

  protected override updated(changed: PropertyValues<this>) {
    super.updated(changed);
    if (changed.has("agentId")) {
      this.record = null;
      this.statusError = null;
      this.statusAgentId = "";
      this.reviewOpen = false;
      this.plan = null;
      this.planError = null;
      this.removeResult = null;
      this.removeUnknown = false;
      this.setPendingRemove(null);
      this.clawUpdate.resetForAgent();
      void this.loadStatus();
    }
  }

  private async loadStatus() {
    const agentId = this.agentId;
    const scope = this.gateway.capture();
    if (
      !agentId ||
      !scope ||
      !this.canReadStatus() ||
      (this.statusLoading && this.statusAgentId === agentId)
    ) {
      return;
    }
    const revision = ++this.statusRevision;
    this.statusAgentId = agentId;
    this.statusLoading = true;
    this.statusError = null;
    try {
      const record = await readClawStatus(scope.client, agentId);
      if (
        this.gateway.isCurrent(scope) &&
        revision === this.statusRevision &&
        this.agentId === agentId
      ) {
        this.record = record;
        if (record && !this.reviewOpen && this.removeResult?.status === "partial") {
          this.removeResult = null;
        }
        this.clawUpdate.onStatusLoaded(record);
      }
    } catch (error) {
      if (
        this.gateway.isCurrent(scope) &&
        revision === this.statusRevision &&
        this.agentId === agentId
      ) {
        this.statusError = formatUiError(error, t("clawsLifecycle.statusUnavailable"));
      }
    } finally {
      if (this.gateway.isCurrent(scope) && revision === this.statusRevision) {
        this.statusLoading = false;
      }
    }
  }

  private async openRemoveReview() {
    const agentId = this.agentId;
    const scope = this.gateway.capture();
    if (
      !agentId ||
      !scope ||
      !this.record ||
      !this.canRemove() ||
      this.removeUnknown ||
      this.removeResult ||
      this.clawUpdate.updating ||
      this.clawUpdate.unknown ||
      this.clawUpdate.reviewOpen
    ) {
      return;
    }
    const revision = ++this.planRevision;
    this.reviewOpen = true;
    this.plan = null;
    this.planError = null;
    this.planLoading = true;
    try {
      const plan = await planClawRemoval(scope.client, agentId);
      if (
        this.gateway.isCurrent(scope) &&
        revision === this.planRevision &&
        this.agentId === agentId
      ) {
        this.plan = plan;
      }
    } catch (error) {
      if (
        this.gateway.isCurrent(scope) &&
        revision === this.planRevision &&
        this.agentId === agentId
      ) {
        this.planError = formatUiError(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope) && revision === this.planRevision) {
        this.planLoading = false;
      }
    }
  }

  private closeReview() {
    if (this.removing) {
      return;
    }
    this.reviewOpen = false;
    if (!this.removeUnknown) {
      this.planRevision += 1;
      this.plan = null;
      this.planError = null;
    }
  }

  private setPendingRemove(next: PendingRemove | null) {
    const previous = this.pendingRemove;
    this.pendingRemove = next;
    if (previous?.agentId !== next?.agentId) {
      if (previous) {
        this.onRemovePendingChange?.(previous.agentId, false);
      }
      if (next) {
        this.onRemovePendingChange?.(next.agentId, true);
      }
    }
  }

  private async reconcileRemove() {
    const pending = this.pendingRemove;
    const scope = this.gateway.capture();
    const context = this.context;
    if (
      !pending ||
      !scope ||
      this.statusChecking ||
      context.gateway.connection.gatewayUrl !== pending.gatewayUrl ||
      this.agentId !== pending.agentId
    ) {
      return;
    }
    this.statusChecking = true;
    try {
      const [statusResult, agentsResult] = await Promise.allSettled([
        readClawStatus(scope.client, pending.agentId),
        context.agents.refreshList(),
      ]);
      if (!this.gateway.isCurrent(scope) || this.pendingRemove !== pending) {
        return;
      }
      if (statusResult.status !== "fulfilled") {
        return;
      }
      const record = statusResult.value;
      this.record = record;
      if (!record) {
        const agents = agentsResult.status === "fulfilled" ? agentsResult.value : null;
        const agentRemoved = Boolean(
          agents && !agents.agents.some((agent) => agent.id === pending.agentId),
        );
        if (!pending.agentWasMissing && !pending.agentRetainedByPlan && !agentRemoved) {
          return;
        }
        this.setPendingRemove(null);
        this.removeUnknown = false;
        this.removeResult = {
          agentId: pending.agentId,
          status: "complete",
          agentRemoved: !pending.agentWasMissing && agentRemoved,
        };
        this.reviewOpen = false;
        if (this.onRemoved) {
          this.onRemoved(pending.agentId);
        } else {
          context.navigate("agents");
        }
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.statusChecking = false;
      }
    }
  }

  private async confirmRemove() {
    const plan = this.plan;
    const agentId = this.agentId;
    const scope = this.gateway.capture();
    if (
      !plan ||
      !agentId ||
      !scope ||
      !this.canRemove() ||
      this.removing ||
      this.removeUnknown ||
      this.removeResult ||
      this.clawUpdate.updating ||
      this.clawUpdate.unknown ||
      this.clawUpdate.reviewOpen ||
      plan.blockers.length > 0 ||
      plan.actions.some((action) => action.blocked) ||
      plan.riskAcknowledgementRequired
    ) {
      return;
    }
    const revision = this.planRevision;
    const context = this.context;
    this.setPendingRemove({
      agentId,
      gatewayUrl: context.gateway.connection.gatewayUrl,
      agentWasMissing: this.record?.agentState === "missing",
      agentRetainedByPlan: plan.actions.some(
        (action) =>
          action.kind === "agent" &&
          action.id === agentId &&
          action.action === "retain" &&
          !action.blocked,
      ),
    });
    this.removing = true;
    this.planError = null;
    try {
      const result = await applyClawRemoval(scope.client, agentId, plan);
      if (
        !this.gateway.isCurrent(scope) ||
        revision !== this.planRevision ||
        this.agentId !== agentId
      ) {
        return;
      }
      try {
        await context.agents.refreshList();
      } catch {
        // The mutation result is known even when refreshing the roster fails.
      }
      if (
        !this.gateway.isCurrent(scope) ||
        revision !== this.planRevision ||
        this.agentId !== agentId
      ) {
        return;
      }
      this.setPendingRemove(null);
      this.removeUnknown = false;
      this.removeResult = result;
      if (result.status === "complete") {
        this.record = null;
        this.reviewOpen = false;
        if (this.onRemoved) {
          this.onRemoved(agentId);
        } else {
          context.navigate("agents");
        }
      } else {
        void this.loadStatus();
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope) && revision === this.planRevision) {
        if (isRejectedClawMutation(error)) {
          this.setPendingRemove(null);
          this.plan = null;
          this.planError = formatUiError(error);
        } else {
          this.removeUnknown = true;
          void this.reconcileRemove();
        }
      }
    } finally {
      if (this.gateway.isCurrent(scope) && revision === this.planRevision) {
        this.removing = false;
      }
    }
  }

  private clawsEnabled(): boolean {
    const runtimeConfig = this.context?.runtimeConfig;
    return Boolean(
      clawsLab &&
      runtimeConfig &&
      resolveLabFeatureState(currentConfigObject(runtimeConfig.state), clawsLab).enabled,
    );
  }

  private isOfficialPackage(): boolean {
    return (
      this.record?.sourceKind === "package" &&
      /^@openclaw\/[a-z0-9][a-z0-9._-]*$/.test(this.record.name)
    );
  }

  private canUpdate(): boolean {
    return (
      this.clawsEnabled() &&
      this.isOfficialPackage() &&
      !this.statusLoading &&
      !this.removing &&
      !this.removeUnknown &&
      !this.removeResult &&
      !this.reviewOpen &&
      !this.clawUpdate.unknown &&
      !this.clawUpdate.result &&
      canCallGatewayMethod(this.gateway.snapshot, "claws.catalog.search", "operator.read") &&
      canCallGatewayMethod(this.gateway.snapshot, "claws.catalog.detail", "operator.read") &&
      canCallGatewayMethod(this.gateway.snapshot, "claws.update.plan", "operator.read") &&
      canCallGatewayMethod(this.gateway.snapshot, "claws.update.apply", "operator.admin")
    );
  }

  private canRemove(): boolean {
    return (
      !this.clawUpdate.updating &&
      !this.clawUpdate.unknown &&
      !this.clawUpdate.reviewOpen &&
      canCallGatewayMethod(this.gateway.snapshot, "claws.remove.plan", "operator.read") &&
      canCallGatewayMethod(this.gateway.snapshot, "claws.remove.apply", "operator.admin")
    );
  }

  private canReadStatus(): boolean {
    return canCallGatewayMethod(this.gateway.snapshot, "claws.status", "operator.read");
  }

  override render() {
    return renderAgentClawPanel({
      available: this.canReadStatus(),
      record: this.record,
      statusLoading: this.statusLoading,
      statusError: this.statusError,
      canRemove: this.canRemove(),
      showUpdate: this.clawsEnabled() && this.isOfficialPackage(),
      canUpdate: this.canUpdate(),
      updateReviewOpen: this.clawUpdate.reviewOpen,
      updateDetail: this.clawUpdate.detail,
      updatePlan: this.clawUpdate.plan,
      updateLoading: this.clawUpdate.loading,
      updateError: this.clawUpdate.error,
      updating: this.clawUpdate.updating,
      updateResult: this.clawUpdate.result,
      updateUnknown: this.clawUpdate.unknown,
      updateStatusChecking: this.clawUpdate.statusChecking,
      updateClawHubRiskAccepted: this.clawUpdate.clawHubRiskAccepted,
      acceptedPluginRisks: this.clawUpdate.acceptedPluginRisks,
      acceptedSkillWarnings: this.clawUpdate.acceptedSkillWarnings,
      reviewOpen: this.reviewOpen,
      plan: this.plan,
      planLoading: this.planLoading,
      planError: this.planError,
      removing: this.removing,
      removeResult: this.removeResult,
      removeUnknown: this.removeUnknown,
      statusChecking: this.statusChecking,
      onRefresh: () => void this.loadStatus(),
      onRemove: () => void this.openRemoveReview(),
      onCloseReview: () => this.closeReview(),
      onRetryPlan: () => void this.openRemoveReview(),
      onConfirmRemove: () => void this.confirmRemove(),
      onCheckStatus: () => void this.reconcileRemove(),
      onUpdate: () => void this.clawUpdate.openReview(),
      onCloseUpdateReview: () => this.clawUpdate.closeReview(),
      onRetryUpdatePlan: () => void this.clawUpdate.openReview(),
      onConfirmUpdate: () => void this.clawUpdate.confirm(),
      onCheckUpdateStatus: () => void this.clawUpdate.reconcile(),
      onUpdateClawHubRiskAcknowledged: (checked) =>
        this.clawUpdate.setClawHubRiskAcknowledged(checked),
      onUpdatePluginRiskAcknowledged: (key, checked) =>
        this.clawUpdate.setPluginRiskAcknowledged(key, checked),
      onUpdateSkillRiskAcknowledged: (key, checked) =>
        this.clawUpdate.setSkillRiskAcknowledged(key, checked),
    });
  }
}

if (!customElements.get("openclaw-agent-claw-panel")) {
  customElements.define("openclaw-agent-claw-panel", AgentClawPanel);
}
