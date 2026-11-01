import { createMemo, onSettled } from "solid-js";
import type { ApplicationContext } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { createPresenceActivityLifecycle } from "../lib/presence-activity-lifecycle.ts";
import { profileDirectory } from "../lib/profile-directory.ts";
import { listen } from "../lib/reactive/listener.ts";
import { projectOwner } from "../lib/reactive/projection.ts";
import { showToast } from "../lib/toast.ts";
import { sidebarPresenceActivityViewers, sidebarPresenceScope } from "./app-sidebar-presence.ts";
import type { AppSidebarSessionNavigationElement } from "./app-sidebar-session-navigation.ts";
import { registerPersonActivityData } from "./person-activity-data.ts";
import type { SidebarPeopleRuntime } from "./sidebar-people.runtime.ts";

export type SidebarPeopleStatusFilter = "all" | "running";
export type SidebarPeopleSortMode = "presence" | "running" | "open" | "name";

/** Snapshot restoration reads these choices synchronously, before view consumers run. */
export class SidebarPeoplePreferences {
  presenceFilter: "online" | "all" = "online";
  statusFilter: SidebarPeopleStatusFilter = "all";
  sortMode: SidebarPeopleSortMode = "presence";

  constructor(private readonly notify: () => void) {}

  set<K extends "presenceFilter" | "statusFilter" | "sortMode">(key: K, value: this[K]): void {
    this[key] = value;
    this.notify();
  }
  resetView(): void {
    this.statusFilter = "all";
    this.sortMode = "presence";
    this.notify();
  }
}

/** Lazy interactions and presence observations belong to the current sidebar view. */
export function createSidebarPeople(
  host: AppSidebarSessionNavigationElement,
  people: SidebarPeoplePreferences,
  current: () => AppSidebarSessionNavigationElement,
  context: ApplicationContext,
) {
  let runtime: SidebarPeopleRuntime | null = null;
  let loading: Promise<typeof import("./sidebar-people.runtime.ts")> | null = null;
  let generation = 0;
  let pendingTarget: HTMLElement | null = null;
  let stopPending: (() => void)[] = [];
  let activityScope = "";
  const activityExpiry = createPresenceActivityLifecycle(
    () => (host.connected ? sidebarPresenceActivityViewers(host) : []),
    () => host.refreshPresencePresentation(),
  );
  const directory = createMemo(() => {
    const gateway = current().sessionDataContext?.gateway;
    return gateway && host.navigationView === "online" && people.presenceFilter === "all"
      ? profileDirectory(gateway)
      : null;
  });
  const profiles = createMemo(() => {
    const source = directory();
    return source ? projectOwner(source, (profileState) => profileState) : null;
  });
  const clearPending = () => {
    pendingTarget = null;
    stopPending.forEach((stop) => stop());
    stopPending = [];
  };
  const dismiss = () => {
    generation += 1;
    clearPending();
    return runtime?.dismiss() ?? false;
  };
  const cancelPending = (event: Event) => {
    if (
      event instanceof KeyboardEvent
        ? event.key === "Escape"
        : event.target instanceof Node && !pendingTarget?.contains(event.target)
    ) {
      dismiss();
    }
  };
  const handleEvent = (event: Event): void => {
    if (!host.isConnected) {
      return;
    }
    // Links own clicks, including modified browser gestures; only hover/focus opens their card.
    if (
      event.type === "click" &&
      event.target instanceof Element &&
      event.target.closest("a[href]")
    ) {
      return;
    }
    if (runtime) {
      runtime.handleEvent(event);
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
    const requestGeneration = ++generation;
    clearPending();
    pendingTarget = target;
    stopPending = [
      listen(document, "pointerdown", cancelPending, true),
      listen(document, "keydown", cancelPending, true),
    ];
    const client = host.sessionDataContext?.gateway.snapshot.client;
    const gateway = host.sessionDataContext?.gateway;
    const hello = gateway?.snapshot.hello;
    const route = host.activeRouteId;
    const sessionKey = host.sessionKey;
    const startedAt = performance.now();
    loading ??= import("./sidebar-people.runtime.ts");
    void loading.then(
      (module) => {
        if (requestGeneration === generation) {
          clearPending();
        }
        if (
          requestGeneration !== generation ||
          !host.isConnected ||
          !target.isConnected ||
          gateway !== host.sessionDataContext?.gateway ||
          client !== gateway?.snapshot.client ||
          hello !== gateway?.snapshot.hello ||
          route !== host.activeRouteId ||
          sessionKey !== host.sessionKey
        ) {
          return;
        }
        runtime ??= new module.SidebarPeopleRuntime(host);
        runtime.handleEvent(event, startedAt);
      },
      () => {
        loading = null;
        if (requestGeneration === generation && host.isConnected) {
          clearPending();
          showToast({ message: t("presence.card.loadFailed") });
        }
      },
    );
  };
  onSettled(() => {
    const stopActivity = registerPersonActivityData(context, host.sessionData);
    const stopPresence = context.gateway.subscribeEvents((event) => {
      if (event.event === "presence") {
        activityExpiry.sync();
      }
    });
    const stops = ["pointerover", "pointerout", "focusin", "focusout", "click", "keydown"].map(
      (event) => listen(host.hostElement, event, handleEvent),
    );
    activityExpiry.connect();
    return () => {
      stopActivity();
      stopPresence();
      stops.forEach((stop) => stop());
      activityExpiry.disconnect();
      dismiss();
      runtime?.dispose();
    };
  });
  return {
    directory: () => profiles()?.read() ?? null,
    dismiss,
    capture() {
      profiles()?.revision();
      activityExpiry.sync();
    },
    syncRendered() {
      const { online, activityProfileIds } = sidebarPresenceScope(host);
      const scope = JSON.stringify([online, ...Array.from(activityProfileIds).toSorted()]);
      if (scope !== activityScope) {
        activityScope = scope;
        // New headers need deadlines; unchanged commits retain pre-render wakeups.
        activityExpiry.sync();
      }
      runtime?.sync();
    },
  };
}
