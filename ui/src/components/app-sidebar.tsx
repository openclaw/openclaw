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
import { createParkedProjection } from "../lib/reactive/parked-projection.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import { PluginView } from "../plugins/control-ui-view.solid.tsx";
import { appSidebarProperties, type AppSidebarProps } from "./app-sidebar-base.ts";
import { AppSidebarOwner } from "./app-sidebar-owner.tsx";
import { createSessionPullRequestIndicators } from "./app-sidebar-session-pr-indicators.ts";
import { createSidebarScroll } from "./sidebar-context-controller.ts";
import { createSidebarNavigationCatalog } from "./sidebar-navigation-catalog.ts";

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
  }
}

function AppSidebarContent(props: AppSidebarProps, host: HTMLElement): JSX.Element {
  host.style.display = "contents";
  const context = useApplication();
  const catalog = createSidebarNavigationCatalog(context, () => props.navigationView, host);
  const owner = sidebarOwners.get(host) ?? new AppSidebarOwner(catalog, props, context, host);
  owner.navigationCatalog = catalog;
  owner.bindInputs(props, context);
  const scroll = createSidebarScroll(owner);
  const projection = projectSource(owner, {
    read: (current) => current,
    subscribe: (current, notify) => current.subscribe(notify),
    equality: "revision",
  });
  const prepared = createMemo(
    () => {
      projection.revision();
      Object.values(props);
      // Snapshot capture keeps observing Pages after its navigation view closes.
      void catalog.dashboards;
      // Synchronous owners release boot snapshots and restore query state before row consumers read.
      owner.prepareRender();
      return owner;
    },
    { equals: false },
  );
  const presentationRevision = createParkedProjection(
    () => {
      Object.values(props);
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
  [
    owner.sidebarMenus,
    owner.sidebarMenus.catalogMenu,
    owner.sessionData,
    owner.sessionOrganizer,
    owner.people,
  ].forEach(observe);
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
  const content = hostView.renderSidebar(Sessions, scroll);
  createEffect(
    () => {
      prepared();
      scroll.capture();
    },
    () =>
      untrack(() => {
        owner.commitRender();
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
    sidebarOwners.set(host, owner);
    if (host.isConnected && !owner.isConnected) {
      owner.attach();
    }
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => owner.classList.add("sidebar-r"));
    });
    return () => cancelAnimationFrame(frame);
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
