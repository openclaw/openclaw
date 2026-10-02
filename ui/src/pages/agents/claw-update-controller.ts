import type { ReactiveControllerHost } from "lit";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayPageController } from "../../lit/gateway-page-controller.ts";
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
import { skillAcknowledgements } from "../agents-home/claws-skill-review.ts";
import {
  applyOfficialClawUpdate,
  planOfficialClawUpdate,
  type ClawUpdatePlan,
  type ClawUpdateResult,
} from "./claw-lifecycle-client.ts";

type ClawUpdateHost = ReactiveControllerHost & { agentId: string };

type PendingUpdate = {
  agentId: string;
  packageName: string;
  version: string;
  gatewayUrl: string;
  readiness?: ClawUpdatePlan["readiness"];
};

export class ClawUpdateController {
  reviewOpen = false;
  detail: ClawCatalogDetail | null = null;
  plan: ClawUpdatePlan | null = null;
  loading = false;
  error: string | null = null;
  updating = false;
  result: ClawUpdateResult | null = null;
  unknown = false;
  statusChecking = false;
  clawHubRiskAccepted = false;
  acceptedPluginRisks = new Set<string>();
  acceptedSkillWarnings = new Set<string>();

  private revision = 0;
  private pending: PendingUpdate | null = null;

  constructor(
    private readonly host: ClawUpdateHost,
    private readonly gateway: GatewayPageController,
    private readonly options: {
      getRecord: () => ClawStatusRecord | null;
      setRecord: (record: ClawStatusRecord | null) => void;
      getGatewayUrl: () => string;
      canReviewUpdate: () => boolean;
      canApplyUpdate: () => boolean;
      loadStatus: () => void;
    },
  ) {}

  onGatewayIdentityChange(gatewayUrl: string): void {
    if (!this.pending || this.pending.gatewayUrl !== gatewayUrl) {
      this.pending = null;
      this.unknown = false;
      this.result = null;
      this.reviewOpen = false;
      this.detail = null;
      this.plan = null;
      this.host.requestUpdate();
    }
  }

  invalidateRequests(): void {
    this.revision += 1;
    this.loading = false;
    this.statusChecking = false;
    if (this.pending) {
      this.unknown = true;
    }
    this.updating = false;
    this.host.requestUpdate();
  }

  resetForAgent(): void {
    this.revision += 1;
    this.reviewOpen = false;
    this.detail = null;
    this.plan = null;
    this.error = null;
    this.result = null;
    this.unknown = false;
    this.pending = null;
    this.host.requestUpdate();
  }

  onStatusLoaded(record: ClawStatusRecord | null): void {
    if (
      record &&
      !this.reviewOpen &&
      this.result &&
      (this.result.status !== "complete" || record.version === this.detail?.version)
    ) {
      this.result = null;
      this.detail = null;
      this.plan = null;
      this.host.requestUpdate();
    }
  }

  async openReview(): Promise<void> {
    const record = this.options.getRecord();
    const scope = this.gateway.capture();
    if (!record || !scope || !this.options.canReviewUpdate()) {
      return;
    }
    const revision = ++this.revision;
    this.reviewOpen = true;
    this.detail = null;
    this.plan = null;
    this.error = null;
    this.loading = true;
    this.clawHubRiskAccepted = false;
    this.acceptedPluginRisks = new Set();
    this.acceptedSkillWarnings = new Set();
    this.host.requestUpdate();
    try {
      const detail = await readLatestOfficialClawDetail(scope.client, record.name);
      if (
        !this.gateway.isCurrent(scope) ||
        revision !== this.revision ||
        this.host.agentId !== record.agentId ||
        this.options.getRecord()?.version !== record.version
      ) {
        return;
      }
      this.detail = detail;
      this.host.requestUpdate();
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
        revision === this.revision &&
        this.host.agentId === record.agentId &&
        this.options.getRecord()?.version === record.version
      ) {
        this.plan = plan;
      }
    } catch (error) {
      if (
        this.gateway.isCurrent(scope) &&
        revision === this.revision &&
        this.host.agentId === record.agentId
      ) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope) && revision === this.revision) {
        this.loading = false;
        this.host.requestUpdate();
      }
    }
  }

  closeReview(): void {
    if (this.updating) {
      return;
    }
    this.reviewOpen = false;
    if (!this.unknown) {
      this.revision += 1;
      if (!this.result) {
        this.detail = null;
        this.plan = null;
        this.error = null;
      } else {
        this.options.loadStatus();
      }
    }
    this.host.requestUpdate();
  }

  async reconcile(): Promise<void> {
    const pending = this.pending;
    const scope = this.gateway.capture();
    if (
      !pending ||
      !scope ||
      this.statusChecking ||
      this.options.getGatewayUrl() !== pending.gatewayUrl ||
      this.host.agentId !== pending.agentId
    ) {
      return;
    }
    this.statusChecking = true;
    this.host.requestUpdate();
    try {
      const record = await readClawStatus(scope.client, pending.agentId);
      if (!this.gateway.isCurrent(scope) || this.pending !== pending) {
        return;
      }
      this.options.setRecord(record);
      if (
        record?.name !== pending.packageName ||
        record.sourceKind !== "package" ||
        record.version !== pending.version
      ) {
        return;
      }
      this.result = {
        agentId: record.agentId,
        status: record.status,
        readiness: pending.readiness ?? { ready: false, requirements: [] },
      };
      this.unknown = false;
      this.pending = null;
    } catch {
      // A failed status read cannot resolve an uncertain Update; never resend it here.
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.statusChecking = false;
        this.host.requestUpdate();
      }
    }
  }

  async confirm(): Promise<void> {
    const plan = this.plan;
    const detail = this.detail;
    const record = this.options.getRecord();
    const scope = this.gateway.capture();
    const acknowledgeCapabilities = plan
      ? pluginAcknowledgements(plan.pluginReviews, this.acceptedPluginRisks)
      : null;
    const acknowledgeSkillWarnings = plan
      ? skillAcknowledgements(plan.skillReviews, this.acceptedSkillWarnings)
      : null;
    if (
      !plan ||
      !detail ||
      !record ||
      !scope ||
      !this.options.canApplyUpdate() ||
      this.updating ||
      this.unknown ||
      this.result ||
      plan.blockers.length > 0 ||
      plan.actions.some((action) => action.blocked) ||
      !hasCompleteClawDisclosures(plan) ||
      plan.target.agentId !== record.agentId ||
      plan.target.currentVersion !== record.version ||
      plan.target.targetVersion !== detail.version ||
      (plan.riskAcknowledgementRequired && !this.clawHubRiskAccepted) ||
      !acknowledgeCapabilities ||
      !acknowledgeSkillWarnings
    ) {
      return;
    }
    const revision = this.revision;
    const source: ClawCatalogSource = {
      packageName: detail.packageName,
      version: detail.version,
    };
    this.pending = {
      agentId: record.agentId,
      packageName: detail.packageName,
      version: detail.version,
      gatewayUrl: this.options.getGatewayUrl(),
      readiness: plan.readiness,
    };
    this.updating = true;
    this.error = null;
    this.host.requestUpdate();
    try {
      const result = await applyOfficialClawUpdate(
        scope.client,
        record.agentId,
        source,
        plan,
        this.clawHubRiskAccepted,
        acknowledgeCapabilities,
        acknowledgeSkillWarnings,
      );
      if (
        !this.gateway.isCurrent(scope) ||
        revision !== this.revision ||
        this.host.agentId !== record.agentId
      ) {
        return;
      }
      this.pending = null;
      this.unknown = false;
      this.result = result;
      this.options.loadStatus();
    } catch (error) {
      if (this.gateway.isCurrent(scope) && revision === this.revision && !this.result) {
        if (isRejectedClawMutation(error)) {
          this.pending = null;
          this.plan = null;
          this.error = formatUiError(error);
        } else {
          this.unknown = true;
          void this.reconcile();
        }
      }
    } finally {
      if (this.gateway.isCurrent(scope) && revision === this.revision) {
        this.updating = false;
        this.host.requestUpdate();
      }
    }
  }

  setClawHubRiskAcknowledged(checked: boolean): void {
    this.clawHubRiskAccepted = checked;
    this.host.requestUpdate();
  }

  setPluginRiskAcknowledged(key: string, checked: boolean): void {
    const accepted = new Set(this.acceptedPluginRisks);
    if (checked) {
      accepted.add(key);
    } else {
      accepted.delete(key);
    }
    this.acceptedPluginRisks = accepted;
    this.host.requestUpdate();
  }

  setSkillRiskAcknowledged(key: string, checked: boolean): void {
    const accepted = new Set(this.acceptedSkillWarnings);
    if (checked) {
      accepted.add(key);
    } else {
      accepted.delete(key);
    }
    this.acceptedSkillWarnings = accepted;
    this.host.requestUpdate();
  }
}
