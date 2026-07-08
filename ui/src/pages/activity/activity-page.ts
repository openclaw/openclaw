import { consume } from "@lit/context";
import { html, LitElement } from "lit";
import { state } from "lit/decorators.js";
import type { EventLogEntry } from "../../api/event-log.ts";
import type { GatewayEventFrame } from "../../api/gateway.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { loadSettings } from "../../app/settings.ts";
import { resolveSessionKey } from "../../lib/sessions/index.ts";
import { uiSessionEventMatches } from "../../lib/sessions/session-key.ts";
import {
  parseToolActivityEvent,
  updateToolActivity,
  type ActivityEntry,
  type ActivityStatus,
} from "./tool-activity.ts";
import { renderActivity } from "./view.ts";

let activityClearBoundary: EventLogEntry | undefined;

class ActivityPage extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @consume({ context: applicationContext, subscribe: false })
  private context!: ApplicationContext;

  @state() private entries: ActivityEntry[] = [];
  @state() private filterText = "";
  @state() private statusFilters: Record<ActivityStatus, boolean> = {
    running: true,
    done: true,
    error: true,
  };
  @state() private toolFilter = "";
  @state() private expandedIds = new Set<string>();
  @state() private autoFollow = true;
  @state() private atBottom = true;

  private sessionKey = "";
  private replayFrame: number | null = null;
  private scrollFrame: number | null = null;
  private stopGatewaySubscription?: () => void;
  private stopGatewayEvents?: () => void;

  override connectedCallback() {
    super.connectedCallback();
    this.syncSessionKey();
    this.stopGatewayEvents = this.context.gateway.subscribeEvents((event) => {
      this.applyGatewayEvent(event, Date.now());
    });
    this.stopGatewaySubscription = this.context.gateway.subscribe(() => {
      const previousSessionKey = this.sessionKey;
      this.syncSessionKey();
      if (this.sessionKey !== previousSessionKey) {
        this.rebuildEntries();
      }
    });
  }

  override firstUpdated() {
    this.replayFrame = requestAnimationFrame(() => {
      this.replayFrame = null;
      if (this.isConnected) {
        this.rebuildEntries();
      }
    });
  }

  override updated(changed: Map<PropertyKey, unknown>) {
    if (this.autoFollow && this.atBottom && (changed.has("entries") || changed.has("autoFollow"))) {
      this.scheduleScroll(changed.has("autoFollow"));
    }
  }

  override disconnectedCallback() {
    this.stopGatewaySubscription?.();
    this.stopGatewaySubscription = undefined;
    this.stopGatewayEvents?.();
    this.stopGatewayEvents = undefined;
    if (this.replayFrame !== null) {
      cancelAnimationFrame(this.replayFrame);
      this.replayFrame = null;
    }
    if (this.scrollFrame !== null) {
      cancelAnimationFrame(this.scrollFrame);
      this.scrollFrame = null;
    }
    super.disconnectedCallback();
  }

  private syncSessionKey() {
    const snapshot = this.context.gateway.snapshot;
    this.sessionKey = resolveSessionKey(loadSettings().sessionKey, snapshot.hello);
  }

  private rebuildEntries() {
    let entries: ActivityEntry[] = [];
    const eventLog = this.context.gateway.eventLog;
    const clearIndex = activityClearBoundary ? eventLog.indexOf(activityClearBoundary) : -1;
    const visibleEvents = clearIndex < 0 ? eventLog : eventLog.slice(0, clearIndex);
    for (const event of visibleEvents.toReversed()) {
      entries = this.reduceGatewayEvent(entries, event.event, event.payload, event.ts);
    }
    if (entries.length > 0 || this.entries.length > 0) {
      this.entries = entries;
    }
    if (this.expandedIds.size > 0) {
      this.expandedIds = new Set();
    }
    this.atBottom = true;
  }

  private applyGatewayEvent(event: GatewayEventFrame, receivedAt: number) {
    const nextEntries = this.reduceGatewayEvent(
      this.entries,
      event.event,
      event.payload,
      receivedAt,
    );
    if (nextEntries !== this.entries) {
      this.entries = nextEntries;
    }
  }

  private reduceGatewayEvent(
    entries: ActivityEntry[],
    eventName: string,
    payload: unknown,
    receivedAt: number,
  ): ActivityEntry[] {
    if (eventName !== "agent" && eventName !== "session.tool") {
      return entries;
    }
    const event = parseToolActivityEvent(payload, receivedAt);
    if (!event) {
      return entries;
    }
    const gateway = this.context.gateway.snapshot;
    if (
      !uiSessionEventMatches(
        {
          sessionKey: this.sessionKey,
          assistantAgentId: gateway.assistantAgentId,
          hello: gateway.hello,
        },
        event.sessionKey,
        event.agentId,
      )
    ) {
      return entries;
    }
    return updateToolActivity(entries, event);
  }

  private scheduleScroll(force = false) {
    if (this.scrollFrame !== null) {
      cancelAnimationFrame(this.scrollFrame);
    }
    void this.updateComplete.then(() => {
      if (!this.isConnected) {
        return;
      }
      this.scrollFrame = requestAnimationFrame(() => {
        this.scrollFrame = null;
        const container = this.querySelector<HTMLElement>(".activity-stream");
        if (!container) {
          return;
        }
        const distanceFromBottom =
          container.scrollHeight - container.scrollTop - container.clientHeight;
        if (!force && (!this.autoFollow || (!this.atBottom && distanceFromBottom >= 120))) {
          return;
        }
        container.scrollTop = container.scrollHeight;
        this.atBottom = true;
      });
    });
  }

  private handleScroll(event: Event) {
    const container = event.currentTarget as HTMLElement | null;
    if (!container) {
      return;
    }
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    this.atBottom = distanceFromBottom < 120;
  }

  private clearEntries() {
    activityClearBoundary = this.context.gateway.eventLog[0];
    this.entries = [];
    this.expandedIds = new Set();
    this.atBottom = true;
  }

  override render() {
    return html`
      <section class="content-header content-header--page">
        <div>
          <div class="page-title">${titleForRoute("activity")}</div>
          <div class="page-sub">${subtitleForRoute("activity")}</div>
        </div>
      </section>
      ${renderActivity({
        entries: this.entries,
        filterText: this.filterText,
        statusFilters: this.statusFilters,
        toolFilter: this.toolFilter,
        expandedIds: this.expandedIds,
        autoFollow: this.autoFollow,
        onFilterTextChange: (next) => (this.filterText = next),
        onToolFilterChange: (next) => (this.toolFilter = next),
        onStatusToggle: (status, enabled) => {
          this.statusFilters = { ...this.statusFilters, [status]: enabled };
        },
        onToggleAutoFollow: (next) => {
          this.autoFollow = next;
          if (next) {
            this.scheduleScroll(true);
          }
        },
        onClear: () => this.clearEntries(),
        onExpandAll: () => {
          this.expandedIds = new Set(this.entries.map((entry) => entry.id));
        },
        onCollapseAll: () => {
          this.expandedIds = new Set();
        },
        onEntryToggle: (id, open) => {
          const next = new Set(this.expandedIds);
          if (open) {
            next.add(id);
          } else {
            next.delete(id);
          }
          this.expandedIds = next;
        },
        onScroll: (event) => this.handleScroll(event),
      })}
    `;
  }
}

customElements.define("openclaw-activity-page", ActivityPage);
