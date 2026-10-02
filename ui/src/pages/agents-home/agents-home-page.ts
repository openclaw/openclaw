import { html, type PropertyValues } from "lit";
import { state } from "lit/decorators.js";
import { t } from "../../i18n/index.ts";
import { registerAgentsHomeEnglish } from "../../i18n/locales/en-agents-home.ts";
import { AgentRosterElement } from "../../lib/agents/roster-element.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { LAB_FEATURES, resolveLabFeatureState } from "../labs/labs-registry.ts";
import {
  listClawStatus,
  type ClawCatalogEntry,
  type ClawStatusRecord,
} from "./claws-catalog-client.ts";
import "./claws-catalog-dialog.ts";
import { renderAgentsHome } from "./view.ts";

registerAgentsHomeEnglish();

const clawsLab = LAB_FEATURES.find((feature) => feature.id === "claws");

export class AgentsHomePage extends AgentRosterElement {
  @state() private catalogOpen = false;
  @state() private selectedClaw: ClawCatalogEntry | null = null;
  @state() private installedClaws: ClawStatusRecord[] = [];
  @state() private statusLoading = false;
  @state() private statusError: string | null = null;
  @state() private inspectedClawId: string | null = null;
  @state() private removePendingAgentId: string | null = null;
  @state() private removedClaw = false;

  private statusRevision = 0;
  private loadedStatusForConnection = false;
  private inspectedGatewayUrl = "";
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    onIdentityChange: () => {
      if (this.inspectedGatewayUrl !== this.context?.gateway.connection.gatewayUrl) {
        this.inspectedClawId = null;
        this.removePendingAgentId = null;
      }
    },
    invalidateRequests: () => {
      this.statusRevision += 1;
      this.loadedStatusForConnection = false;
      this.installedClaws = [];
      this.statusLoading = false;
      this.statusError = null;
      this.removedClaw = false;
    },
    onSnapshot: () => {
      if (this.gateway.connected && this.canReadClawStatus() && !this.loadedStatusForConnection) {
        void this.loadInstalledStatus();
      }
    },
    onPageActivation: () => {
      if (document.visibilityState !== "hidden") {
        void this.loadInstalledStatus();
      }
    },
  });

  constructor() {
    super();
    new SubscriptionsController(this).effect(
      () => this.context?.runtimeConfig,
      (runtimeConfig) => {
        void runtimeConfig.ensureLoaded();
        return runtimeConfig.subscribe(() => {
          if (!this.clawsEnabled()) {
            this.catalogOpen = false;
            this.selectedClaw = null;
          }
          this.requestUpdate();
        });
      },
    );
  }

  private clawsEnabled(): boolean {
    return Boolean(
      clawsLab &&
      resolveLabFeatureState(currentConfigObject(this.context.runtimeConfig.state), clawsLab)
        .enabled,
    );
  }

  private canReadClawStatus(): boolean {
    return canCallGatewayMethod(this.gateway.snapshot, "claws.status", "operator.read");
  }

  private async loadInstalledStatus() {
    const scope = this.gateway.capture();
    if (!scope || !this.canReadClawStatus()) {
      return;
    }
    const revision = ++this.statusRevision;
    this.loadedStatusForConnection = true;
    this.statusLoading = true;
    this.statusError = null;
    try {
      const records = await listClawStatus(scope.client);
      if (this.gateway.isCurrent(scope) && revision === this.statusRevision) {
        this.installedClaws = records;
        if (
          this.inspectedClawId &&
          this.removePendingAgentId !== this.inspectedClawId &&
          !records.some((record) => record.agentId === this.inspectedClawId)
        ) {
          this.inspectedClawId = null;
        }
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope) && revision === this.statusRevision) {
        this.statusError = formatUiError(error, t("clawsLifecycle.statusUnavailable"));
      }
    } finally {
      if (this.gateway.isCurrent(scope) && revision === this.statusRevision) {
        this.statusLoading = false;
      }
    }
  }

  protected override willUpdate(changed: PropertyValues<this>) {
    super.willUpdate(changed);
    if (
      this.inspectedClawId &&
      this.removePendingAgentId !== this.inspectedClawId &&
      this.roster.cards.some((card) => card.id === this.inspectedClawId)
    ) {
      this.inspectedClawId = null;
    }
  }

  override render() {
    const clawsEnabled = this.clawsEnabled();
    return this.avatars.withActiveRoutes(() => {
      const cards = this.cards().toSorted(
        (a, b) =>
          Number(b.activeNow) - Number(a.activeNow) ||
          b.lastActiveAt - a.lastActiveAt ||
          Number(b.id === this.context.agents.state.agentsList?.defaultId) -
            Number(a.id === this.context.agents.state.agentsList?.defaultId) ||
          a.id.localeCompare(b.id),
      );
      const representedAgents = new Set(cards.map((card) => card.id));
      return html`${renderAgentsHome({
        cards,
        context: this.context,
        connected: this.connected,
        loading: this.roster.loading,
        error: this.roster.error ?? this.roster.subscriptionError,
        onRetry: () => void this.refresh(),
        unrepresentedClaws: this.installedClaws.filter(
          (record) => !representedAgents.has(record.agentId),
        ),
        clawsStatusLoading: this.statusLoading,
        clawsStatusError: this.statusError,
        inspectedClawId: this.inspectedClawId,
        removePendingAgentId: this.removePendingAgentId,
        removedClaw: this.removedClaw,
        onRetryClawsStatus: () => void this.loadInstalledStatus(),
        onInspectClaw: (agentId) => {
          if (this.removePendingAgentId) {
            return;
          }
          this.inspectedClawId = this.inspectedClawId === agentId ? null : agentId;
          this.inspectedGatewayUrl = this.context.gateway.connection.gatewayUrl;
          this.removedClaw = false;
        },
        onClawRemoved: (agentId) => {
          this.removePendingAgentId = null;
          this.inspectedClawId = null;
          this.installedClaws = this.installedClaws.filter((record) => record.agentId !== agentId);
          this.removedClaw = true;
          void this.loadInstalledStatus();
        },
        onClawRemovePendingChange: (agentId, pending) => {
          if (pending) {
            this.removePendingAgentId = agentId;
          } else if (this.removePendingAgentId === agentId) {
            this.removePendingAgentId = null;
          }
        },
        canCreate: canCallGatewayMethod(
          this.context.gateway.snapshot,
          "openclaw.chat",
          "operator.admin",
        ),
        showExplore: clawsEnabled,
        onOpenCatalog: () => {
          this.selectedClaw = null;
          this.catalogOpen = true;
        },
        onSelectClaw: (entry) => {
          this.selectedClaw = entry;
          this.catalogOpen = true;
        },
      })}
      ${
        clawsEnabled && this.catalogOpen
          ? html`<openclaw-claws-catalog-dialog
              .initialEntry=${this.selectedClaw}
              .onClose=${() => {
                this.catalogOpen = false;
                this.selectedClaw = null;
              }}
              .onAdded=${() => {
                this.removedClaw = false;
                void this.refresh();
                void this.loadInstalledStatus();
              }}
            ></openclaw-claws-catalog-dialog>`
          : ""
      }`;
    });
  }
}

export const header = true;
export const render = () => html`<openclaw-agents-home-page></openclaw-agents-home-page>`;

if (!customElements.get("openclaw-agents-home-page")) {
  customElements.define("openclaw-agents-home-page", AgentsHomePage);
}
