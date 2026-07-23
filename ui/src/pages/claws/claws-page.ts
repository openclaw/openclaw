import { consume } from "@lit/context";
import { html } from "lit";
import { state } from "lit/decorators.js";
import {
  type ClawsDoctorResult,
  type ClawsStatusResult,
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
import { renderClaws } from "./view.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : String(error);
}

class ClawsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private connected = false;
  @state() private available = false;
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private status: ClawsStatusResult | null = null;
  @state() private doctor: ClawsDoctorResult | null = null;
  @state() private selectedAgentId: string | null = null;

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
    if (clientChanged || !this.connected || !this.available) {
      this.generation += 1;
      this.loading = false;
      if (clientChanged) {
        this.status = null;
        this.doctor = null;
        this.error = null;
        this.selectedAgentId = null;
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
        throw new Error("Gateway returned an invalid Claw lifecycle response.");
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

  override render() {
    return html`
      <section class="content-header content-header--page">
        <div>
          <div class="page-title">${titleForRoute("claws")}</div>
        </div>
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
        loading: this.loading,
        error: this.error,
        status: this.status,
        doctor: this.doctor,
        selectedAgentId: this.selectedAgentId,
        onSelect: (agentId) => {
          this.selectedAgentId = agentId;
        },
      })}
    `;
  }
}

if (!customElements.get("openclaw-claws-page")) {
  customElements.define("openclaw-claws-page", ClawsPage);
}
