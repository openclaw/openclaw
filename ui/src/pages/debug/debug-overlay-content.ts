import { html } from "lit";
import "../../styles/debug-data.css";
import { property, state as litState } from "lit/decorators.js";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { SYSTEM_INFO_POLL_INTERVAL_MS } from "../../lib/system-info.ts";
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

const DEBUG_OVERLAY_HISTORY_LIMIT = 90;

type SectionState =
  | { status: "loading" }
  | { status: "ready"; value: unknown }
  | { status: "unavailable" };

class DebugOverlayContent extends OpenClawLightDomElement {
  @property({ attribute: false }) context?: ApplicationContext;
  @property({ type: Boolean }) minimized = false;
  @litState() private sections = new Map<string, SectionState>();

  private readonly requestControllers = new Map<string, AbortController>();
  private requestGeneration = 0;
  private statusHistory: DebugOverlayStatusSample[] = [];
  private readonly polling = new PollController(
    this,
    SYSTEM_INFO_POLL_INTERVAL_MS,
    () => void this.refreshSections(),
    false,
    "visible",
  );
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => this.resetSections(),
    ensureInitialData: () => void this.refreshSections(),
    onPageActivation: () => this.syncPolling(),
  });
  private readonly subscriptions = new SubscriptionsController(this).watch(
    () =>
      !this.minimized && document.visibilityState !== "hidden" ? this.context?.gateway : undefined,
    (gateway, notify) => gateway.subscribeEventLog(notify),
  );

  override connectedCallback(): void {
    super.connectedCallback();
    this.syncPolling();
  }

  override disconnectedCallback(): void {
    this.polling.stop();
    this.subscriptions.clear();
    this.resetSections();
    super.disconnectedCallback();
  }

  private resetSections(): void {
    this.requestGeneration += 1;
    for (const controller of this.requestControllers.values()) {
      controller.abort();
    }
    this.requestControllers.clear();
    this.statusHistory = [];
    this.sections = new Map(
      DEBUG_OVERLAY_SECTIONS.map((section) => [
        section.id,
        { status: this.gateway.connected ? "loading" : "unavailable" },
      ]),
    );
  }

  private syncPolling(): void {
    if (document.visibilityState === "hidden") {
      this.polling.stop();
    } else if (this.polling.start()) {
      void this.refreshSections();
    }
    this.requestUpdate();
  }

  private async refreshSections(): Promise<void> {
    const gateway = this.gateway.gateway;
    const client = this.gateway.connected ? this.gateway.client : null;
    if (!this.isConnected || document.visibilityState === "hidden") {
      return;
    }
    if (!gateway || !client) {
      this.sections = new Map(
        DEBUG_OVERLAY_SECTIONS.map((section) => [section.id, { status: "unavailable" }]),
      );
      return;
    }
    const generation = this.requestGeneration;
    const sections = this.minimized
      ? DEBUG_OVERLAY_SECTIONS.filter((section) => section.id === "status")
      : DEBUG_OVERLAY_SECTIONS;
    const requests = sections.map(async (section): Promise<void> => {
      // A slow roster or lane read must not stop fresh vitals, or overlap itself.
      if (this.requestControllers.has(section.id)) {
        return;
      }
      const controller = new AbortController();
      this.requestControllers.set(section.id, controller);
      try {
        const value = await section.load({ client, gateway }, controller.signal);
        this.updateSection(generation, section.id, { status: "ready", value });
      } catch {
        this.updateSection(generation, section.id, { status: "unavailable" });
      } finally {
        if (this.requestControllers.get(section.id) === controller) {
          this.requestControllers.delete(section.id);
        }
      }
    });
    await Promise.allSettled(requests);
  }

  private updateSection(generation: number, id: string, state: SectionState): void {
    if (!this.isConnected || generation !== this.requestGeneration) {
      return;
    }
    if (id === "status" && state.status === "ready") {
      this.polling.stop();
      this.polling.start();
      // SAFETY: The status descriptor owns this section id and always returns a status snapshot.
      const snapshot = state.value as DebugOverlayStatusSnapshot;
      if (this.statusHistory.at(-1)?.at !== snapshot.sampledAt) {
        this.statusHistory = [
          ...this.statusHistory.slice(-(DEBUG_OVERLAY_HISTORY_LIMIT - 1)),
          { at: snapshot.sampledAt, status: snapshot },
        ];
      }
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
