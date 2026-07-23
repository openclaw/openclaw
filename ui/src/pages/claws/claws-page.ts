import { consume } from "@lit/context";
import { html } from "lit";
import { state } from "lit/decorators.js";
import {
  type ClawCatalogDetail,
  type ClawCatalogEntry,
  type ClawLifecycleApplyResult,
  type ClawLifecyclePlanResult,
  type ClawStatusEntry,
  type ClawsCatalogDetailResult,
  type ClawsCatalogSearchResult,
  type ClawsDoctorResult,
  type ClawsStatusResult,
  validateClawLifecycleApplyResult,
  validateClawLifecyclePlanResult,
  validateClawsCatalogDetailResult,
  validateClawsCatalogSearchResult,
  validateClawsDoctorResult,
  validateClawsStatusResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { titleForRoute } from "../../app-navigation.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import "../../styles/claws.css";
import { buildClawApplyRequest, type PendingClawOperation } from "./lifecycle-request.ts";
import { renderClaws } from "./view.ts";

type ClawsMode = "installed" | "discover";

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : String(error);
}

class ClawsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private connected = false;
  @state() private available = false;
  @state() private catalogAvailable = false;
  @state() private lifecycleAvailable = false;
  @state() private loading = false;
  @state() private operationBusy = false;
  @state() private error: string | null = null;
  @state() private status: ClawsStatusResult | null = null;
  @state() private doctor: ClawsDoctorResult | null = null;
  @state() private selectedAgentId: string | null = null;
  @state() private mode: ClawsMode = "installed";
  @state() private query = "";
  @state() private catalogEntries: ClawCatalogEntry[] = [];
  @state() private catalogDetail: ClawCatalogDetail | null = null;
  @state() private plan: ClawLifecyclePlanResult | null = null;
  @state() private outcome: ClawLifecycleApplyResult | null = null;
  @state() private pendingOperation: PendingClawOperation | null = null;
  @state() private removeUnused = false;
  @state() private riskAcknowledged = false;

  private gatewaySource?: ApplicationContext["gateway"];
  private client: GatewayBrowserClient | null = null;
  private generation = 0;
  private readonly subscriptions = new SubscriptionsController(this).effect(
    () => this.context?.gateway,
    (gateway) => {
      this.gatewaySource = gateway;
      this.applyGatewaySnapshot(gateway.snapshot);
      return gateway.subscribe((snapshot) => {
        if (this.gatewaySource === gateway) {
          this.applyGatewaySnapshot(snapshot);
        }
      });
    },
  );

  override disconnectedCallback() {
    this.generation += 1;
    this.gatewaySource = undefined;
    this.client = null;
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  private applyGatewaySnapshot(snapshot: ApplicationGatewaySnapshot) {
    const clientChanged = this.client !== snapshot.client;
    const wasConnected = this.connected;
    const wasAvailable = this.available;
    this.client = snapshot.client;
    this.connected = snapshot.connected;
    this.available =
      isGatewayMethodAdvertised(snapshot, "claws.status") === true &&
      isGatewayMethodAdvertised(snapshot, "claws.doctor") === true;
    this.catalogAvailable =
      isGatewayMethodAdvertised(snapshot, "claws.catalog.search") === true &&
      isGatewayMethodAdvertised(snapshot, "claws.catalog.detail") === true;
    this.lifecycleAvailable = [
      "claws.add.plan",
      "claws.add.apply",
      "claws.update.plan",
      "claws.update.apply",
      "claws.remove.plan",
      "claws.remove.apply",
    ].every((method) => isGatewayMethodAdvertised(snapshot, method) === true);
    if (clientChanged || !this.connected || !this.available) {
      this.generation += 1;
      this.loading = false;
      this.operationBusy = false;
      if (clientChanged) {
        this.resetState();
      }
    }
    if (
      this.connected &&
      this.available &&
      (clientChanged || !wasConnected || !wasAvailable || !this.status)
    ) {
      void this.refresh();
    }
  }

  private resetState() {
    this.status = null;
    this.doctor = null;
    this.error = null;
    this.selectedAgentId = null;
    this.catalogEntries = [];
    this.catalogDetail = null;
    this.cancelPlan();
  }

  private async refresh() {
    const gateway = this.gatewaySource;
    const client = this.client;
    if (
      !gateway ||
      gateway !== this.context.gateway ||
      !this.connected ||
      !this.available ||
      !client
    ) {
      return;
    }
    const generation = ++this.generation;
    this.loading = true;
    this.error = null;
    try {
      const [statusPayload, doctorPayload] = await Promise.all([
        client.request("claws.status", {}),
        client.request("claws.doctor", {}),
      ]);
      if (!validateClawsStatusResult(statusPayload) || !validateClawsDoctorResult(doctorPayload)) {
        throw new Error(t("clawsPage.errors.invalidLifecycle"));
      }
      if (
        this.generation !== generation ||
        this.gatewaySource !== gateway ||
        this.client !== client
      ) {
        return;
      }
      this.status = statusPayload;
      this.doctor = doctorPayload;
      const selectedStillExists = statusPayload.records.some(
        (record) => record.agentId === this.selectedAgentId,
      );
      if (!selectedStillExists) {
        this.selectedAgentId = statusPayload.records[0]?.agentId ?? null;
      }
    } catch (error) {
      if (this.generation === generation) {
        this.error = errorMessage(error);
      }
    } finally {
      if (this.generation === generation) {
        this.loading = false;
      }
    }
  }

  private async runOperation(operation: () => Promise<void>) {
    if (!this.client || this.operationBusy) {
      return;
    }
    this.operationBusy = true;
    this.error = null;
    try {
      await operation();
    } catch (error) {
      this.error = errorMessage(error);
    } finally {
      this.operationBusy = false;
    }
  }

  private async searchCatalog() {
    const query = this.query.trim();
    if (!query || !this.catalogAvailable) {
      return;
    }
    await this.runOperation(async () => {
      const payload = await this.client!.request<ClawsCatalogSearchResult>("claws.catalog.search", {
        query,
      });
      if (!validateClawsCatalogSearchResult(payload)) {
        throw new Error(t("clawsPage.errors.invalidCatalog"));
      }
      this.catalogEntries = payload.entries;
      this.catalogDetail = null;
      this.cancelPlan();
    });
  }

  private async selectCatalogEntry(entry: ClawCatalogEntry) {
    await this.runOperation(async () => {
      const payload = await this.client!.request<ClawsCatalogDetailResult>("claws.catalog.detail", {
        packageName: entry.packageName,
        ...(entry.latestVersion ? { version: entry.latestVersion } : {}),
      });
      if (!validateClawsCatalogDetailResult(payload)) {
        throw new Error(t("clawsPage.errors.invalidCatalog"));
      }
      this.catalogDetail = payload.detail;
      this.cancelPlan();
    });
  }

  private installedForDetail(): ClawStatusEntry | undefined {
    return this.catalogDetail
      ? this.status?.records.find((record) => record.name === this.catalogDetail!.packageName)
      : undefined;
  }

  private async previewAdd(detail: ClawCatalogDetail) {
    const pending: PendingClawOperation = {
      operation: "add",
      source: { packageName: detail.packageName, version: detail.version },
    };
    await this.loadPlan(pending);
  }

  private async previewUpdate(record: ClawStatusEntry, detail?: ClawCatalogDetail) {
    const pending: PendingClawOperation = {
      operation: "update",
      target: record.agentId,
      ...(detail ? { source: { packageName: detail.packageName, version: detail.version } } : {}),
    };
    await this.loadPlan(pending);
  }

  private async previewRemove(record: ClawStatusEntry) {
    await this.loadPlan({ operation: "remove", target: record.agentId });
  }

  private async loadPlan(pending: PendingClawOperation) {
    if (!this.lifecycleAvailable) {
      return;
    }
    await this.runOperation(async () => {
      const method = `claws.${pending.operation}.plan`;
      const params =
        pending.operation === "add"
          ? { source: pending.source }
          : pending.operation === "update"
            ? { target: pending.target, ...(pending.source ? { source: pending.source } : {}) }
            : { target: pending.target, removeUnused: this.removeUnused };
      const payload = await this.client!.request<ClawLifecyclePlanResult>(method, params);
      if (!validateClawLifecyclePlanResult(payload)) {
        throw new Error(t("clawsPage.errors.invalidPlan"));
      }
      this.pendingOperation = pending;
      this.plan = payload;
      this.outcome = null;
      this.riskAcknowledged = false;
    });
  }

  private async replanRemove(removeUnused: boolean) {
    this.removeUnused = removeUnused;
    if (this.pendingOperation?.operation === "remove") {
      await this.loadPlan(this.pendingOperation);
    }
  }

  private cancelPlan() {
    this.plan = null;
    this.pendingOperation = null;
    this.removeUnused = false;
    this.riskAcknowledged = false;
  }

  private async applyPlan() {
    const pending = this.pendingOperation;
    const plan = this.plan;
    if (!pending || !plan) {
      return;
    }
    const request = buildClawApplyRequest({
      pending,
      plan,
      removeUnused: this.removeUnused,
      riskAcknowledged: this.riskAcknowledged,
    });
    if (!request) {
      return;
    }
    await this.runOperation(async () => {
      const payload = await this.client!.request<ClawLifecycleApplyResult>(
        request.method,
        request.request,
      );
      if (!validateClawLifecycleApplyResult(payload)) {
        throw new Error(t("clawsPage.errors.invalidOutcome"));
      }
      this.outcome = payload;
      this.plan = null;
      this.pendingOperation = null;
      await this.refresh();
    });
  }

  override render() {
    return html`
      <section class="content-header content-header--page">
        <div><div class="page-title">${titleForRoute("claws")}</div></div>
        <div class="page-header-actions">
          <button
            class="btn"
            type="button"
            title=${t("clawsPage.refresh")}
            ?disabled=${!this.connected || !this.available || this.loading}
            @click=${() => void this.refresh()}
          >
            ${this.loading ? t("common.refreshing") : t("common.refresh")}
          </button>
        </div>
      </section>
      ${renderClaws({
        connected: this.connected,
        available: this.available,
        catalogAvailable: this.catalogAvailable,
        lifecycleAvailable: this.lifecycleAvailable,
        loading: this.loading,
        operationBusy: this.operationBusy,
        error: this.error,
        status: this.status,
        doctor: this.doctor,
        selectedAgentId: this.selectedAgentId,
        mode: this.mode,
        query: this.query,
        catalogEntries: this.catalogEntries,
        catalogDetail: this.catalogDetail,
        installedCatalogAgent: this.installedForDetail(),
        plan: this.plan,
        outcome: this.outcome,
        removeUnused: this.removeUnused,
        riskAcknowledged: this.riskAcknowledged,
        onSelect: (agentId) => {
          this.selectedAgentId = agentId;
        },
        onModeChange: (mode) => {
          this.mode = mode;
          this.cancelPlan();
        },
        onQueryChange: (query) => {
          this.query = query;
        },
        onSearch: () => void this.searchCatalog(),
        onSelectCatalog: (entry) => void this.selectCatalogEntry(entry),
        onPreviewAdd: (detail) => void this.previewAdd(detail),
        onPreviewUpdate: (record, detail) => void this.previewUpdate(record, detail),
        onPreviewRemove: (record) => void this.previewRemove(record),
        onRemoveUnusedChange: (value) => void this.replanRemove(value),
        onRiskAcknowledgedChange: (value) => {
          this.riskAcknowledged = value;
        },
        onCancelPlan: () => this.cancelPlan(),
        onApplyPlan: () => void this.applyPlan(),
      })}
    `;
  }
}

if (!customElements.get("openclaw-claws-page")) {
  customElements.define("openclaw-claws-page", ClawsPage);
}
