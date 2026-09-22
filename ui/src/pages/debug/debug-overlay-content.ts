import { html } from "lit";
import "../../styles/debug-data.css";
import { property, state as litState } from "lit/decorators.js";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { PollController } from "../../lit/poll-controller.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { renderDebugOverlaySectionLoading } from "./debug-overlay-loading.ts";
import {
  DEBUG_OVERLAY_SECTIONS,
  renderDebugOverlayWidget,
  type DebugOverlaySectionDescriptor,
  type DebugOverlayStatusSample,
  type DebugOverlayStatusSnapshot,
} from "./debug-overlay-sections.ts";

const DEBUG_OVERLAY_POLL_INTERVAL_MS = 2000;
const DEBUG_OVERLAY_HISTORY_LIMIT = 90;

type SectionState =
  | { status: "loading" }
  | { status: "ready"; value: unknown }
  | { status: "unavailable" };

class DebugOverlayContent extends OpenClawLightDomElement {
  @property({ attribute: false }) context?: ApplicationContext;
  @property({ type: Boolean }) minimized = false;
  @litState() private sections = new Map<string, SectionState>();

  private requestController: AbortController | null = null;
  private requestActive = false;
  private requestGeneration = 0;
  private statusHistory: DebugOverlayStatusSample[] = [];
  private readonly polling = new PollController(
    this,
    DEBUG_OVERLAY_POLL_INTERVAL_MS,
    () => void this.refreshSections(),
  );
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => this.resetSections(),
    ensureInitialData: () => void this.refreshSections(),
  });
  private readonly subscriptions = new SubscriptionsController(this).watch(
    () => this.context?.gateway,
    (gateway, notify) => gateway.subscribeEventLog(notify),
  );

  override disconnectedCallback(): void {
    this.polling.stop();
    this.subscriptions.clear();
    this.resetSections();
    super.disconnectedCallback();
  }

  private resetSections(): void {
    this.requestGeneration += 1;
    this.requestController?.abort();
    this.requestController = null;
    this.requestActive = false;
    this.statusHistory = [];
    this.sections = new Map(
      DEBUG_OVERLAY_SECTIONS.map((section) => [
        section.id,
        { status: this.gateway.connected ? "loading" : "unavailable" },
      ]),
    );
  }

  private async refreshSections(): Promise<void> {
    const gateway = this.gateway.gateway;
    const client = this.gateway.connected ? this.gateway.client : null;
    if (!this.isConnected || this.requestActive) {
      return;
    }
    if (!gateway || !client) {
      this.sections = new Map(
        DEBUG_OVERLAY_SECTIONS.map((section) => [section.id, { status: "unavailable" }]),
      );
      return;
    }
    this.requestActive = true;
    const generation = ++this.requestGeneration;
    const controller = new AbortController();
    this.requestController?.abort();
    this.requestController = controller;
    const sections = this.minimized
      ? DEBUG_OVERLAY_SECTIONS.filter((section) => section.id === "status")
      : DEBUG_OVERLAY_SECTIONS;
    const requests = sections.map(async (section): Promise<void> => {
      try {
        const value = await section.load({ client, gateway }, controller.signal);
        this.updateSection(generation, section.id, { status: "ready", value });
      } catch {
        this.updateSection(generation, section.id, { status: "unavailable" });
      }
    });
    await Promise.allSettled(requests);
    if (!this.isConnected || generation !== this.requestGeneration) {
      return;
    }
    this.requestController = null;
    this.requestActive = false;
  }

  private updateSection(generation: number, id: string, state: SectionState): void {
    if (!this.isConnected || generation !== this.requestGeneration) {
      return;
    }
    if (id === "status" && state.status === "ready") {
      // SAFETY: The status descriptor owns this section id and always returns a status snapshot.
      const snapshot = state.value as DebugOverlayStatusSnapshot;
      this.statusHistory = [
        ...this.statusHistory.slice(-(DEBUG_OVERLAY_HISTORY_LIMIT - 1)),
        { at: Date.now(), status: snapshot },
      ];
    }
    const next = new Map(this.sections);
    next.set(id, state);
    this.sections = next;
  }

  private renderSection(section: DebugOverlaySectionDescriptor) {
    const state = this.sections.get(section.id) ?? { status: "loading" };
    return html`
      <section class="debug-overlay__section" aria-busy=${state.status === "loading"}>
        <h3>${t(section.titleKey)}</h3>
        ${
          state.status === "loading"
            ? renderDebugOverlaySectionLoading(section.id)
            : state.status === "unavailable"
              ? html`<div class="debug-overlay__empty">${t("debug.overlay.unavailable")}</div>`
              : section.render(state.value, this.statusHistory)
        }
      </section>
    `;
  }

  override render() {
    if (this.minimized) {
      const state = this.sections.get("status") ?? { status: "loading" };
      if (state.status !== "ready") {
        return html`<div class="debug-overlay__compact-loading" role="status">
          ${t(state.status === "loading" ? "common.loading" : "debug.overlay.unavailable")}
        </div>`;
      }
      // SAFETY: The status descriptor pairs system.info with its measured round trip.
      const snapshot = state.value as DebugOverlayStatusSnapshot;
      return renderDebugOverlayWidget(snapshot, this.statusHistory);
    }
    return html`${DEBUG_OVERLAY_SECTIONS.map((section) => this.renderSection(section))}`;
  }
}

if (!customElements.get("openclaw-debug-overlay-content")) {
  customElements.define("openclaw-debug-overlay-content", DebugOverlayContent);
}
