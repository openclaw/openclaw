import { consume } from "@lit/context";
import type { PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { registerAgentsHomeEnglish } from "../../i18n/locales/en-agents-home.ts";
import { resolveEditableSnapshotConfig } from "../../lib/config/config-state-model.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { hasCompleteClawDisclosures } from "../agents-home/claws-access-review.ts";
import {
  readClawStatus,
  readLatestOfficialClawDetail,
  type ClawCatalogDetail,
  type ClawCatalogSource,
  type ClawStatusRecord,
} from "../agents-home/claws-catalog-client.ts";
import { isRejectedClawMutation } from "../agents-home/claws-mutation-error.ts";
import { pluginAcknowledgements } from "../agents-home/claws-plugin-review.ts";
import { LAB_FEATURES, resolveLabFeatureState } from "../labs/labs-registry.ts";
import {
  applyOfficialClawUpdate,
  applyClawRemoval,
  planOfficialClawUpdate,
  planClawRemoval,
  type ClawLifecyclePlan,
  type ClawRemoveResult,
  type ClawUpdatePlan,
  type ClawUpdateResult,
} from "./claw-lifecycle-client.ts";
import { renderAgentClawPanel } from "./claw-lifecycle-view.ts";

registerAgentsHomeEnglish();

const clawsLab = LAB_FEATURES.find((feature) => feature.id === "claws");

export class AgentClawPanel extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) agentId = "";

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
  @state() private updateReviewOpen = false;
  @state() private updateDetail: ClawCatalogDetail | null = null;
  @state() private updatePlan: ClawUpdatePlan | null = null;
  @state() private updateLoading = false;
  @state() private updateError: string | null = null;
  @state() private updating = false;
  @state() private updateResult: ClawUpdateResult | null = null;
  @state() private updateUnknown = false;
  @state() private updateStatusChecking = false;
  @state() private updateClawHubRiskAccepted = false;
  @state() private acceptedPluginRisks = new Set<string>();

  private statusRevision = 0;
  private planRevision = 0;
  private updateRevision = 0;
  private statusAgentId = "";
  private pendingRemove: { agentId: string; gatewayUrl: string } | null = null;
  private pendingUpdate: {
    agentId: string;
    version: string;
    gatewayUrl: string;
    readiness?: ClawUpdatePlan["readiness"];
  } | null = null;

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
        this.pendingRemove = null;
        this.removeUnknown = false;
        this.removeResult = null;
        this.reviewOpen = false;
      }
      if (
        !this.pendingUpdate ||
        this.pendingUpdate.gatewayUrl !== this.context.gateway.connection.gatewayUrl
      ) {
        this.pendingUpdate = null;
        this.updateUnknown = false;
        this.updateResult = null;
        this.updateReviewOpen = false;
        this.updateDetail = null;
        this.updatePlan = null;
      }
    },
    invalidateRequests: () => {
      this.statusRevision += 1;
      this.planRevision += 1;
      this.updateRevision += 1;
      this.statusLoading = false;
      this.planLoading = false;
      this.updateLoading = false;
      this.statusChecking = false;
      this.updateStatusChecking = false;
      if (this.pendingRemove) {
        this.removeUnknown = true;
      }
      if (this.pendingUpdate) {
        this.updateUnknown = true;
      }
      this.removing = false;
      this.updating = false;
    },
    ensureInitialData: () => {
      void this.loadStatus();
      if (this.removeUnknown) {
        void this.reconcileRemove();
      }
      if (this.updateUnknown) {
        void this.reconcileUpdate();
      }
    },
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
      this.pendingRemove = null;
      this.updateRevision += 1;
      this.updateReviewOpen = false;
      this.updateDetail = null;
      this.updatePlan = null;
      this.updateError = null;
      this.updateResult = null;
      this.updateUnknown = false;
      this.pendingUpdate = null;
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
        if (record && !this.reviewOpen && this.removeResult && !this.removeResult.agentRemoved) {
          this.removeResult = null;
        }
        if (
          record &&
          !this.updateReviewOpen &&
          this.updateResult &&
          (this.updateResult.status !== "complete" || record.version === this.updateDetail?.version)
        ) {
          this.updateResult = null;
          this.updateDetail = null;
          this.updatePlan = null;
        }
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
      this.updating ||
      this.updateUnknown ||
      this.updateReviewOpen
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
      const [record, agents] = await Promise.all([
        readClawStatus(scope.client, pending.agentId),
        context.agents.refreshList(),
      ]);
      if (!this.gateway.isCurrent(scope) || this.pendingRemove !== pending) {
        return;
      }
      this.record = record;
      if (!record && agents && !agents.agents.some((agent) => agent.id === pending.agentId)) {
        this.pendingRemove = null;
        this.removeUnknown = false;
        this.removeResult = {
          agentId: pending.agentId,
          status: "complete",
          agentRemoved: true,
        };
        this.reviewOpen = false;
        context.navigate("agents");
      }
    } catch {
      // Absence cannot be trusted after a failed status read; do not permit another Remove.
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
      this.updating ||
      this.updateUnknown ||
      this.updateReviewOpen ||
      plan.blockers.length > 0 ||
      plan.actions.some((action) => action.blocked) ||
      plan.riskAcknowledgementRequired
    ) {
      return;
    }
    const revision = this.planRevision;
    const context = this.context;
    this.pendingRemove = { agentId, gatewayUrl: context.gateway.connection.gatewayUrl };
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
      this.pendingRemove = null;
      this.removeUnknown = false;
      this.removeResult = result;
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
      if (result.status === "complete" && result.agentRemoved) {
        this.reviewOpen = false;
        context.navigate("agents");
      } else {
        void this.loadStatus();
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope) && revision === this.planRevision) {
        if (isRejectedClawMutation(error)) {
          this.pendingRemove = null;
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

  private async openUpdateReview() {
    const record = this.record;
    const scope = this.gateway.capture();
    if (!record || !scope || !this.canUpdate()) {
      return;
    }
    const revision = ++this.updateRevision;
    this.updateReviewOpen = true;
    this.updateDetail = null;
    this.updatePlan = null;
    this.updateError = null;
    this.updateLoading = true;
    this.updateClawHubRiskAccepted = false;
    this.acceptedPluginRisks = new Set();
    try {
      const detail = await readLatestOfficialClawDetail(scope.client, record.name);
      if (
        !this.gateway.isCurrent(scope) ||
        revision !== this.updateRevision ||
        this.agentId !== record.agentId ||
        this.record?.version !== record.version
      ) {
        return;
      }
      this.updateDetail = detail;
      if (detail.version === record.version) {
        return;
      }
      const source: ClawCatalogSource = {
        packageName: detail.packageName,
        version: detail.version,
      };
      const plan = await planOfficialClawUpdate(
        scope.client,
        record.agentId,
        record.version,
        source,
      );
      if (
        this.gateway.isCurrent(scope) &&
        revision === this.updateRevision &&
        this.agentId === record.agentId &&
        this.record?.version === record.version
      ) {
        this.updatePlan = plan;
      }
    } catch (error) {
      if (
        this.gateway.isCurrent(scope) &&
        revision === this.updateRevision &&
        this.agentId === record.agentId
      ) {
        this.updateError = formatUiError(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope) && revision === this.updateRevision) {
        this.updateLoading = false;
      }
    }
  }

  private closeUpdateReview() {
    if (this.updating) {
      return;
    }
    this.updateReviewOpen = false;
    if (!this.updateUnknown) {
      this.updateRevision += 1;
      if (!this.updateResult) {
        this.updateDetail = null;
        this.updatePlan = null;
        this.updateError = null;
      } else {
        void this.loadStatus();
      }
    }
  }

  private async reconcileUpdate() {
    const pending = this.pendingUpdate;
    const scope = this.gateway.capture();
    if (
      !pending ||
      !scope ||
      this.updateStatusChecking ||
      this.context.gateway.connection.gatewayUrl !== pending.gatewayUrl ||
      this.agentId !== pending.agentId
    ) {
      return;
    }
    this.updateStatusChecking = true;
    try {
      const record = await readClawStatus(scope.client, pending.agentId);
      if (!this.gateway.isCurrent(scope) || this.pendingUpdate !== pending) {
        return;
      }
      this.record = record;
      if (record?.version !== pending.version) {
        return;
      }
      this.updateResult = {
        agentId: record.agentId,
        status: record.status,
        readiness: pending.readiness ?? { ready: false, requirements: [] },
      };
      this.updateUnknown = false;
      this.pendingUpdate = null;
    } catch {
      // A failed status read cannot resolve an uncertain Update; never resend it here.
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.updateStatusChecking = false;
      }
    }
  }

  private async confirmUpdate() {
    const plan = this.updatePlan;
    const detail = this.updateDetail;
    const record = this.record;
    const scope = this.gateway.capture();
    const acknowledgeCapabilities = plan
      ? pluginAcknowledgements(plan.pluginReviews, this.acceptedPluginRisks)
      : null;
    if (
      !plan ||
      !detail ||
      !record ||
      !scope ||
      !this.canUpdate() ||
      this.updating ||
      this.updateUnknown ||
      this.updateResult ||
      plan.blockers.length > 0 ||
      plan.actions.some((action) => action.blocked) ||
      !hasCompleteClawDisclosures(plan) ||
      plan.target.agentId !== record.agentId ||
      plan.target.currentVersion !== record.version ||
      plan.target.targetVersion !== detail.version ||
      (plan.riskAcknowledgementRequired && !this.updateClawHubRiskAccepted) ||
      !acknowledgeCapabilities
    ) {
      return;
    }
    const revision = this.updateRevision;
    const source: ClawCatalogSource = {
      packageName: detail.packageName,
      version: detail.version,
    };
    this.pendingUpdate = {
      agentId: record.agentId,
      version: detail.version,
      gatewayUrl: this.context.gateway.connection.gatewayUrl,
      readiness: plan.readiness,
    };
    this.updating = true;
    this.updateError = null;
    try {
      const result = await applyOfficialClawUpdate(
        scope.client,
        record.agentId,
        source,
        plan,
        this.updateClawHubRiskAccepted,
        acknowledgeCapabilities,
      );
      if (
        !this.gateway.isCurrent(scope) ||
        revision !== this.updateRevision ||
        this.agentId !== record.agentId
      ) {
        return;
      }
      this.pendingUpdate = null;
      this.updateUnknown = false;
      this.updateResult = result;
      void this.loadStatus();
    } catch (error) {
      if (this.gateway.isCurrent(scope) && revision === this.updateRevision && !this.updateResult) {
        if (isRejectedClawMutation(error)) {
          this.pendingUpdate = null;
          this.updatePlan = null;
          this.updateError = formatUiError(error);
        } else {
          this.updateUnknown = true;
          void this.reconcileUpdate();
        }
      }
    } finally {
      if (this.gateway.isCurrent(scope) && revision === this.updateRevision) {
        this.updating = false;
      }
    }
  }

  private clawsEnabled(): boolean {
    const snapshot = this.context?.runtimeConfig?.state.configSnapshot;
    return Boolean(
      clawsLab &&
      snapshot &&
      resolveLabFeatureState(resolveEditableSnapshotConfig(snapshot), clawsLab).enabled,
    );
  }

  private isOfficialPackage(): boolean {
    return Boolean(
      this.record?.sourceKind === "package" &&
      /^@openclaw\/[a-z0-9][a-z0-9._-]*$/.test(this.record.name),
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
      !this.updateUnknown &&
      !this.updateResult &&
      canCallGatewayMethod(this.gateway.snapshot, "claws.catalog.search", "operator.read") &&
      canCallGatewayMethod(this.gateway.snapshot, "claws.catalog.detail", "operator.read") &&
      canCallGatewayMethod(this.gateway.snapshot, "claws.update.plan", "operator.read") &&
      canCallGatewayMethod(this.gateway.snapshot, "claws.update.apply", "operator.admin")
    );
  }

  private canRemove(): boolean {
    return (
      !this.updating &&
      !this.updateUnknown &&
      !this.updateReviewOpen &&
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
      updateReviewOpen: this.updateReviewOpen,
      updateDetail: this.updateDetail,
      updatePlan: this.updatePlan,
      updateLoading: this.updateLoading,
      updateError: this.updateError,
      updating: this.updating,
      updateResult: this.updateResult,
      updateUnknown: this.updateUnknown,
      updateStatusChecking: this.updateStatusChecking,
      updateClawHubRiskAccepted: this.updateClawHubRiskAccepted,
      acceptedPluginRisks: this.acceptedPluginRisks,
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
      onUpdate: () => void this.openUpdateReview(),
      onCloseUpdateReview: () => this.closeUpdateReview(),
      onRetryUpdatePlan: () => void this.openUpdateReview(),
      onConfirmUpdate: () => void this.confirmUpdate(),
      onCheckUpdateStatus: () => void this.reconcileUpdate(),
      onUpdateClawHubRiskAcknowledged: (checked) => (this.updateClawHubRiskAccepted = checked),
      onUpdatePluginRiskAcknowledged: (key, checked) => {
        const accepted = new Set(this.acceptedPluginRisks);
        if (checked) {
          accepted.add(key);
        } else {
          accepted.delete(key);
        }
        this.acceptedPluginRisks = accepted;
      },
    });
  }
}

if (!customElements.get("openclaw-agent-claw-panel")) {
  customElements.define("openclaw-agent-claw-panel", AgentClawPanel);
}
