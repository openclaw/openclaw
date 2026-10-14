import type { ReactiveController } from "lit";
import { t } from "../i18n/index.ts";
import { profileDirectory } from "../lib/profile-directory.ts";
import { showToast } from "../lib/toast.ts";
import { createPresenceActivityController } from "../lit/presence-activity-controller.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { sidebarPresenceActivityViewers, sidebarPresenceScope } from "./app-sidebar-presence.ts";
import type { AppSidebarSessionNavigationElement } from "./app-sidebar-session-navigation.ts";
import { registerPersonActivityData } from "./person-activity-data.ts";
import type { SidebarPeopleRuntime } from "./sidebar-people.runtime.ts";

export type SidebarPeopleStatusFilter = "all" | "running";
export type SidebarPeoplePresenceFilter = "online" | "all";
export type SidebarPeopleSortMode = "presence" | "running" | "open" | "name";

const EVENTS = ["pointerover", "pointerout", "focusin", "focusout", "click", "keydown"] as const;

/** One lazy interaction owner per sidebar; the data stays in SessionDataController. */
export class SidebarPeopleController implements ReactiveController {
  presenceFilter: SidebarPeoplePresenceFilter = "online";
  statusFilter: SidebarPeopleStatusFilter = "all";
  sortMode: SidebarPeopleSortMode = "presence";
  directory: ReturnType<typeof profileDirectory> | null = null;
  private stopDirectory: (() => void) | undefined;

  setPresenceFilter(value: SidebarPeoplePresenceFilter): void {
    this.presenceFilter = value;
    this.host.requestUpdate();
  }

  setStatusFilter(value: SidebarPeopleStatusFilter): void {
    this.statusFilter = value;
    this.host.requestUpdate();
  }

  setSortMode(value: SidebarPeopleSortMode): void {
    this.sortMode = value;
    this.host.requestUpdate();
  }

  resetView(): void {
    this.statusFilter = "all";
    this.sortMode = "presence";
    this.host.requestUpdate();
  }

  private runtime: SidebarPeopleRuntime | null = null;
  private readonly activityExpiry: ReturnType<typeof createPresenceActivityController>;
  private activityScope = "";
  private loading: Promise<typeof import("./sidebar-people.runtime.ts")> | null = null;
  private generation = 0;
  private pendingTarget: HTMLElement | null = null;

  constructor(private readonly host: AppSidebarSessionNavigationElement) {
    host.addController(this);
    this.activityExpiry = createPresenceActivityController(
      host,
      () => (host.connected ? sidebarPresenceActivityViewers(host) : []),
      () => host.refreshPresencePresentation(),
    );
    new SubscriptionsController(host)
      .effect(
        () => host.sessionDataContext,
        (context) => registerPersonActivityData(context, host.sessionData),
      )
      .effect(
        () => host.sessionDataContext?.gateway,
        (gateway) =>
          gateway.subscribeEvents((event) => {
            if (event.event === "presence") {
              this.activityExpiry.sync();
            }
          }),
      );
  }

  hostConnected(): void {
    for (const event of EVENTS) {
      this.host.addEventListener(event, this.handleEvent);
    }
  }

  hostUpdate(): void {
    this.activityExpiry.sync();
    const gateway = this.host.sessionDataContext?.gateway;
    const directory =
      gateway && this.host.navigationView === "online" && this.presenceFilter === "all"
        ? profileDirectory(gateway)
        : null;
    if (directory !== this.directory) {
      this.stopDirectory?.();
      this.directory = directory;
      this.stopDirectory = directory?.subscribe(() => this.host.requestUpdate());
    }
  }

  hostUpdated(): void {
    const { online, activityProfileIds } = sidebarPresenceScope(this.host);
    const scope = JSON.stringify([online, ...Array.from(activityProfileIds).toSorted()]);
    if (scope !== this.activityScope) {
      this.activityScope = scope;
      // New headers need deadlines; unchanged commits must retain pre-render wakeups.
      this.activityExpiry.sync();
    }
    this.runtime?.sync();
  }

  dismiss(): boolean {
    this.generation += 1;
    this.clearPending();
    return this.runtime?.dismiss() ?? false;
  }

  hostDisconnected(): void {
    this.stopDirectory?.();
    this.stopDirectory = undefined;
    this.directory = null;
    for (const event of EVENTS) {
      this.host.removeEventListener(event, this.handleEvent);
    }
    this.generation += 1;
    this.clearPending();
    this.runtime?.dispose();
    this.runtime = null;
  }

  private clearPending(): void {
    this.pendingTarget = null;
    document.removeEventListener("pointerdown", this.cancelPending, true);
    document.removeEventListener("keydown", this.cancelPending, true);
  }

  private readonly cancelPending = (event: Event) => {
    if (
      event instanceof KeyboardEvent
        ? event.key === "Escape"
        : event.target instanceof Node && !this.pendingTarget?.contains(event.target)
    ) {
      this.generation += 1;
      this.clearPending();
    }
  };

  private readonly handleEvent = (event: Event): void => {
    // Links own clicks, including modified browser gestures; only hover/focus opens their card.
    if (
      event.type === "click" &&
      event.target instanceof Element &&
      event.target.closest("a[href]")
    ) {
      return;
    }
    if (this.runtime) {
      this.runtime.handleEvent(event);
      return;
    }
    const target =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-person-card]")
        : null;
    if (!target || !["pointerover", "focusin", "click"].includes(event.type)) {
      return;
    }
    // Input modality belongs to the runtime; row intent only warms its lazy code.
    const generation = ++this.generation;
    this.pendingTarget = target;
    document.addEventListener("pointerdown", this.cancelPending, true);
    document.addEventListener("keydown", this.cancelPending, true);
    const client = this.host.sessionDataContext?.gateway.snapshot.client;
    const gateway = this.host.sessionDataContext?.gateway;
    const hello = gateway?.snapshot.hello;
    const route = this.host.activeRouteId;
    const sessionKey = this.host.sessionKey;
    const startedAt = performance.now();
    this.loading ??= import("./sidebar-people.runtime.ts");
    void this.loading.then(
      (module) => {
        if (generation === this.generation) {
          this.clearPending();
        }
        if (
          generation !== this.generation ||
          !this.host.isConnected ||
          !target.isConnected ||
          gateway !== this.host.sessionDataContext?.gateway ||
          client !== gateway?.snapshot.client ||
          hello !== gateway?.snapshot.hello ||
          route !== this.host.activeRouteId ||
          sessionKey !== this.host.sessionKey
        ) {
          return;
        }
        this.runtime ??= new module.SidebarPeopleRuntime(this.host);
        this.runtime.handleEvent(event, startedAt);
      },
      () => {
        this.loading = null;
        if (generation === this.generation && this.host.isConnected) {
          this.clearPending();
          showToast({ message: t("presence.card.loadFailed") });
        }
      },
    );
  };
}
