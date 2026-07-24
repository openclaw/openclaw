// AI safety observability page: KPI strip + live event feed + filterable table.
import { consume } from "@lit/context";
import { html } from "lit";
import { state } from "lit/decorators.js";
import type { SafetyEventRecord } from "../../../../src/infra/safety-event-store.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import { titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { type SafetyKpi, renderSafetyPage } from "./view.ts";

const AI_SAFETY_EVENT_PREFIX = "ai_safety.";
const MAX_LIVE_EVENTS = 500;

type SafetyEventsListResult = {
  events: SafetyEventRecord[];
  nextCursor?: string;
};

function buildKpi(events: SafetyEventRecord[]): SafetyKpi {
  const kpi: SafetyKpi = { total: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const e of events) {
    kpi.total++;
    if (e.severity in kpi) {
      (kpi as Record<string, number>)[e.severity]!++;
    }
  }
  return kpi;
}

class SafetyPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private events: SafetyEventRecord[] = [];
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private filterSeverity = "";
  @state() private filterType = "";

  private readonly subscriptions = new SubscriptionsController(this).effect(
    () => this.context?.gateway,
    (gateway) => {
      // Bootstrap: fetch existing events from the gateway store.
      void this.fetchEvents(gateway);

      // Live: subscribe to SSE-style gateway events for real-time appends.
      const stopEvents = gateway.subscribeEvents((frame: GatewayEventFrame) => {
        if (frame.event === "safety.event" && frame.payload && typeof frame.payload === "object") {
          const record = frame.payload as SafetyEventRecord;
          if (record.type?.startsWith(AI_SAFETY_EVENT_PREFIX)) {
            this.events = [record, ...this.events].slice(0, MAX_LIVE_EVENTS);
          }
        }
      });

      return () => {
        stopEvents();
      };
    },
  );

  override disconnectedCallback() {
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  private async fetchEvents(gateway: ApplicationContext["gateway"]): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      const client: GatewayBrowserClient | null = gateway.snapshot.client;
      if (!client) {
        this.error = "Gateway not connected.";
        return;
      }
      const params: Record<string, unknown> = { limit: MAX_LIVE_EVENTS };
      if (this.filterSeverity) {
        params["severity"] = this.filterSeverity;
      }
      if (this.filterType) {
        params["eventType"] = this.filterType;
      }
      const result = await client.request<SafetyEventsListResult>("safety.events.list", params);
      this.events = result.events ?? [];
    } catch (err) {
      this.error = err instanceof Error ? err.message : "Failed to load safety events.";
    } finally {
      this.loading = false;
    }
  }

  private filteredEvents(): SafetyEventRecord[] {
    return this.events.filter((e) => {
      if (this.filterSeverity && e.severity !== this.filterSeverity) {
        return false;
      }
      if (this.filterType && !e.type.startsWith(this.filterType)) {
        return false;
      }
      return true;
    });
  }

  override render() {
    const filtered = this.filteredEvents();
    const body = renderSafetyPage({
      events: filtered,
      kpi: buildKpi(filtered),
      loading: this.loading,
      error: this.error,
      filterSeverity: this.filterSeverity,
      filterType: this.filterType,
      onSeverityChange: (v) => {
        this.filterSeverity = v;
      },
      onTypeChange: (v) => {
        this.filterType = v;
      },
      onRefresh: () => {
        if (this.context?.gateway) {
          void this.fetchEvents(this.context.gateway);
        }
      },
    });
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("safety")}</div>
        </div>
      </section>
      ${renderSettingsWorkspace(body)}
    `;
  }
}

customElements.define("openclaw-safety-page", SafetyPage);
