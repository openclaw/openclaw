import { getObserver } from "@solidjs/signals";
import { insert, type JSX } from "@solidjs/web";
import {
  createEffect,
  createMemo,
  createRoot,
  getOwner,
  onCleanup,
  onSettled,
  runWithOwner,
  Show,
  untrack,
} from "solid-js";
import { useApplication, useOptionalApplication } from "../lib/reactive/context.ts";
import { listen } from "../lib/reactive/listener.ts";
import { createParkedProjection } from "../lib/reactive/parked-projection.ts";
import { projectOwner, projectSource } from "../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import { PluginView } from "../plugins/control-ui-view.solid.tsx";
import { appSidebarProperties, type AppSidebarProps } from "./app-sidebar-base.ts";
import { AppSidebarOwner } from "./app-sidebar-owner.tsx";
import { createSessionPullRequestIndicators } from "./app-sidebar-session-pr-indicators.ts";
import {
  loadStoredHiddenSessionCatalogIds,
  SIDEBAR_HIDDEN_SESSION_CATALOGS_CHANGED_EVENT,
} from "./app-sidebar-session-types.ts";
import { createSessionAttention } from "./session-attention.ts";
import { createSessionOwnerFilterQuery } from "./session-owner-filter.ts";
import { createSidebarScroll } from "./sidebar-context-controller.ts";
import { equalSidebarContext, selectSidebarContext } from "./sidebar-context-state.ts";
import { createSidebarNavigationCatalog } from "./sidebar-navigation-catalog.ts";
import { createSidebarPeople } from "./sidebar-people.ts";

export { AppSidebarOwner } from "./app-sidebar-owner.tsx";

const sidebarOwners = new WeakMap<HTMLElement, AppSidebarOwner>();

export function getAppSidebarOwner(host: HTMLElement): AppSidebarOwner | undefined {
  return sidebarOwners.get(host);
}

export function dismissSidebarTransientMenus(host: HTMLElement): boolean {
  return sidebarOwners.get(host)?.dismissTransientMenus() ?? false;
}

export function promoteSidebarCreatedSession(host: HTMLElement, sessionKey: string): void {
  sidebarOwners.get(host)?.promoteCreatedSession(sessionKey);
}

function disconnectSidebarOwner(host: HTMLElement): void {
  if (host.isConnected) {
    return;
  }
  const owner = sidebarOwners.get(host);
  if (owner) {
    sidebarOwners.delete(host);
    owner.detach();
    owner.disposeMenus();
  }
}

function AppSidebarContent(props: AppSidebarProps, host: HTMLElement): JSX.Element {
  host.style.display = "contents";
  const context = useApplication();
  const catalog = createSidebarNavigationCatalog(context, () => props.navigationView, host);
  const owner = sidebarOwners.get(host) ?? new AppSidebarOwner(catalog, props, context, host);
  sidebarOwners.set(host, owner);
  owner.navigationCatalog = catalog;
  owner.bindInputs(props, context);
  owner.attention = createSessionAttention(
    context,
    owner.attentionQuestions,
    host,
    () => props.navigationVisible,
  );
  const scroll = createSidebarScroll(owner);
  const contextual = createMemo(() => {
    const router = props.router;
    return router
      ? projectSource(router, {
          read: (current) => selectSidebarContext(current.getState()),
          subscribe: (current, notify) =>
            current.subscribeSelector(selectSidebarContext, notify, equalSidebarContext),
          equality: equalSidebarContext,
        })
      : undefined;
  });
  owner.readContextualSidebar = createMemo(() => contextual()?.read(), {
    equals: equalSidebarContext,
  });
  const projection = projectSource(owner, {
    read: (current) => current,
    subscribe: (current, notify) => {
      current.catalogRendererImport.schedule();
      const stops = [
        current.subscribe(notify),
        context.chatSubmissions.subscribeCreate(notify),
        context.theme.subscribe(notify),
        context.config.subscribe(notify),
        context.agentIdentity.subscribe(current.sessionData.requestSessionDataUpdate),
        context.plugins.subscribe(current.sessionData.requestSessionDataUpdate),
        listen(window, SIDEBAR_HIDDEN_SESSION_CATALOGS_CHANGED_EVENT, () => {
          current.hiddenSessionCatalogIds = loadStoredHiddenSessionCatalogIds();
          current.requestUpdate();
        }),
        listen(window, "openclaw:native-gateways-changed", () => {
          if (current.isConnected) {
            current.sidebarMenus.closeSessionMenu();
            notify();
          }
        }),
        current.catalogRendererImport.dispose,
      ];
      return () => stops.forEach((stop) => stop());
    },
    equality: "revision",
  });
  const snapshot = owner.snapshot;
  const snapshotProjection = projectOwner(snapshot, (current) => current.read());
  const snapshotPending = createMemo(() => snapshotProjection.read().pending);
  const snapshotModel = createMemo(() => snapshotProjection.read().model);
  const people = (owner.peopleView = createSidebarPeople(owner, owner.people, () => {
    Object.values(props);
    return projection.read();
  }));
  const prepared = createMemo(
    () => {
      projection.revision();
      snapshotPending();
      snapshotModel();
      Object.values(props);
      void owner.contextualSidebar;
      // Snapshot capture keeps observing Pages after its navigation view closes.
      void catalog.dashboards;
      // Arm presence deadlines before preparation can project a row.
      people.capture();
      // Synchronous owners release boot snapshots and restore query state before row consumers read.
      snapshot.synchronize();
      owner.prepareRender();
      owner.sessionData.synchronize();
      owner.pinnedSessions.synchronize();
      return owner;
    },
    { equals: false },
  );
  createSessionOwnerFilterQuery(owner.sessionOwnerFilter, prepared, () =>
    context.sessions.listSnapshot(owner.sessionData.sessionListQuery(owner.expandedAgentId())),
  );
  const narrationEnabled = createMemo(() => {
    // Preparation reads narration while synchronizing the session projection.
    projection.revision();
    snapshotModel();
    Object.values(props);
    return owner.narrationEnabled();
  });
  const narration = createMemo(() => {
    if (!narrationEnabled()) {
      return null;
    }
    const loaded = createMemo(() => owner.loadNarration(), { loadingValue: null });
    return loaded;
  });
  const narrationProjection = createMemo(() => {
    const source = narration()?.();
    return source ? projectOwner(source, (current) => current.read()) : null;
  });
  owner.readNarration = createParkedProjection(
    () => narrationProjection()?.read(),
    () => props.navigationVisible,
  );
  onSettled(() => context.gateway.subscribeEvents((event) => owner.narration?.handleEvent(event)));
  const presentationRevision = createParkedProjection(
    () => {
      Object.values(props);
      snapshotPending();
      snapshotModel();
      // Router context can reveal parked rows without an owner publication.
      void owner.contextualSidebar;
      return projection.revision();
    },
    () => props.navigationVisible,
  );
  const observed = new WeakMap<object, object>();
  const observe = <T extends object>(target: T): T => {
    const proxy = new Proxy(target, {
      get(current, key, receiver) {
        if (getObserver()) {
          presentationRevision();
        }
        const value = Reflect.get(current, key, receiver);
        return value && typeof value === "object" ? (observed.get(value) ?? value) : value;
      },
    });
    observed.set(target, proxy);
    return proxy;
  };
  const hostView = observe(owner);
  onCleanup(
    owner.sidebarMenus.bindCatalogMenuView(owner.sidebarMenus.catalogMenu.createView(hostView)),
  );
  [owner.sessionData, owner.sessionOrganizer, owner.people].forEach(observe);
  owner.sessionPullRequests = createSessionPullRequestIndicators({
    getConnected: () => prepared().isConnected && props.connected,
    getPresented: () => props.navigationVisible,
    getRows: () => prepared().readSessionPullRequestRows(),
    getSelectedAgentId: () => prepared().selectedAgentIdForSessions(),
    getGateway: () => prepared().sessionDataContext?.gateway,
    getSessions: () => prepared().sessionDataContext?.sessions,
  });
  const solidOwner = getOwner();
  const mountDefaultView = (target: HTMLElement) =>
    runWithOwner(solidOwner, () =>
      createRoot((dispose) => {
        insert(target, hostView.renderSessionsBody());
        return () => {
          dispose();
          target.replaceChildren();
        };
      }),
    );
  const SessionBody = () => hostView.renderSessionsBody();
  const Sessions = () => (
    <Show
      when={Boolean(hostView.sessionDataContext?.plugins.selectedReplacement("session-list"))}
      fallback={<SessionBody />}
    >
      <PluginView
        surface="session-list"
        props={{
          sessionKey: hostView.sessionKey,
          agentId: hostView.getSessionNavigationState().selectedAgentId,
          sessions: hostView.sessionDataContext?.sessions.state.result?.sessions ?? [],
        }}
        presented={hostView.navigationVisible}
        mountDefaultView={mountDefaultView}
      />
    </Show>
  );
  const content = hostView.renderSidebar(Sessions, scroll, {
    pending: snapshotPending,
    saved: () => {
      // Preparation can clear a receipt without publishing another model.
      prepared();
      return snapshotProjection.read().saved;
    },
  });
  createEffect(
    () => {
      prepared();
      narration()?.();
      owner.readNarration();
      scroll.capture();
    },
    () =>
      untrack(() => {
        owner.sessionData.refreshPresentation();
        owner.commitRender();
        if (owner.isConnected) {
          owner.narration?.sync(owner.narrationSyncInput());
        }
        snapshot.capture();
        people.syncRendered();
        scroll.restore();
        // The projection owns the display deadline; this mounted view owns its timer.
        const deadline = owner.sessionProjection.subtitleDeadline;
        if (owner.isConnected && Number.isFinite(deadline)) {
          const timer = globalThis.setTimeout(
            () => {
              owner.sessionProjection.invalidate();
              owner.requestUpdate();
            },
            Math.max(0, deadline - Date.now()),
          );
          return () => globalThis.clearTimeout(timer);
        }
        return undefined;
      }),
  );
  onSettled(() => {
    if (host.isConnected && !owner.isConnected) {
      owner.attach();
    } else {
      owner.sessionData.connect();
    }
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => owner.classList.add("sidebar-r"));
    });
    return () => {
      cancelAnimationFrame(frame);
      owner.sessionData.disconnect(owner.isConnected);
    };
  });
  onCleanup(() => disconnectSidebarOwner(host));
  return content;
}

export type AppSidebarMethods = {
  dismissTransientMenus(): boolean;
  expandedAgentId(): string;
  findSidebarHovercardRowByKey(
    sessionKey: string,
  ): ReturnType<AppSidebarOwner["findSidebarHovercardRowByKey"]> | undefined;
  promoteCreatedSession(sessionKey: string): void;
};
export type AppSidebarElement = SolidBridgeElement<AppSidebarProps, AppSidebarMethods>;

export const AppSidebar = defineSolidBridge<AppSidebarProps, AppSidebarMethods>(
  "openclaw-app-sidebar",
  // Component setup must not subscribe the bridge's provider to this owner's revision.
  (props, host) =>
    untrack(() => (useOptionalApplication() ? AppSidebarContent(props, host) : props.children)),
  {
    properties: appSidebarProperties,
    connected: (host) => sidebarOwners.get(host)?.attach(),
    disconnected: (host) => sidebarOwners.get(host)?.detach(),
    methods: {
      dismissTransientMenus: dismissSidebarTransientMenus,
      expandedAgentId: (host) => sidebarOwners.get(host)?.expandedAgentId() ?? "",
      findSidebarHovercardRowByKey: (host, key) =>
        sidebarOwners.get(host)?.findSidebarHovercardRowByKey(key),
      promoteCreatedSession: promoteSidebarCreatedSession,
    },
  },
);
