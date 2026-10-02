import { html } from "lit";
import { state } from "lit/decorators.js";
import { AgentRosterElement } from "../../lib/agents/roster-element.ts";
import { resolveEditableSnapshotConfig } from "../../lib/config/config-state-model.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { LAB_FEATURES, resolveLabFeatureState } from "../labs/labs-registry.ts";
import type { ClawCatalogEntry } from "./claws-catalog-client.ts";
import "./claws-catalog-dialog.ts";
import { renderAgentsHome } from "./view.ts";

const clawsLab = LAB_FEATURES.find((feature) => feature.id === "claws");

export class AgentsHomePage extends AgentRosterElement {
  @state() private catalogOpen = false;
  @state() private selectedClaw: ClawCatalogEntry | null = null;

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
      resolveLabFeatureState(
        resolveEditableSnapshotConfig(this.context.runtimeConfig.state.configSnapshot),
        clawsLab,
      ).enabled,
    );
  }

  override render() {
    const clawsEnabled = this.clawsEnabled();
    return this.avatars.withActiveRoutes(() => {
      return html`${renderAgentsHome({
        cards: this.cards().toSorted(
          (a, b) =>
            Number(b.activeNow) - Number(a.activeNow) ||
            b.lastActiveAt - a.lastActiveAt ||
            Number(b.id === this.context.agents.state.agentsList?.defaultId) -
              Number(a.id === this.context.agents.state.agentsList?.defaultId) ||
            a.id.localeCompare(b.id),
        ),
        context: this.context,
        connected: this.connected,
        loading: this.roster.loading,
        error: this.roster.error ?? this.roster.subscriptionError,
        onRetry: () => void this.refresh(),
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
                void this.refresh();
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
