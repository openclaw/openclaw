import { getObserver } from "@solidjs/signals";
import { render, type JSX } from "@solidjs/web";
import {
  createEffect,
  getOwner,
  onCleanup,
  onSettled,
  runWithOwner,
  Show,
  untrack,
} from "solid-js";
import { useApplication } from "../lib/reactive/context.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import { appSidebarProperties, type AppSidebarProps } from "./app-sidebar-base.ts";
import { AppSidebarOwner } from "./app-sidebar-owner.tsx";

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

function AppSidebarContent(props: AppSidebarProps, host: HTMLElement): JSX.Element {
  host.style.display = "contents";
  const owner = new AppSidebarOwner(props, useApplication(), host);
  const projection = projectSource(owner, {
    read: (current) => current,
    subscribe: (current, notify) => current.subscribe(notify),
    equality: "revision",
  });
  const observed = new WeakMap<object, object>();
  const observe = <T extends object>(target: T): T => {
    const proxy = new Proxy(target, {
      get(current, key, receiver) {
        if (getObserver()) {
          projection.revision();
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
    owner.navigationCatalog,
  ].forEach(observe);
  const solidOwner = getOwner();
  const mountDefaultView = (target: HTMLElement) =>
    runWithOwner(solidOwner, () => render(() => hostView.renderSessionsBody(), target));
  const SessionBody = () => hostView.renderSessionsBody();
  const Sessions = () => (
    <Show
      when={Boolean(hostView.sessionDataContext?.plugins.selectedReplacement("session-list"))}
      fallback={<SessionBody />}
    >
      <openclaw-plugin-view
        prop:surface="session-list"
        prop:props={{
          sessionKey: hostView.sessionKey,
          agentId: hostView.getSessionNavigationState().selectedAgentId,
          sessions: hostView.sessionDataContext?.sessions.state.result?.sessions ?? [],
        }}
        prop:presented={hostView.navigationVisible}
        prop:mountDefaultView={mountDefaultView}
      />
    </Show>
  );
  const content = hostView.renderSidebar(Sessions);
  createEffect(
    () => {
      projection.revision();
      // Props remain on the bridge's live object; source changes refresh its subscriptions.
      Object.values(props);
      owner.prepareRender();
    },
    () => owner.commitRender(),
  );
  let attachedHost: HTMLElement | undefined;
  onSettled(() => {
    attachedHost = host;
    sidebarOwners.set(attachedHost, owner);
    owner.attach();
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => owner.classList.add("sidebar-r"));
    });
    return () => cancelAnimationFrame(frame);
  });
  onCleanup(() => {
    owner.detach();
    if (attachedHost && sidebarOwners.get(attachedHost) === owner) {
      sidebarOwners.delete(attachedHost);
    }
  });
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
  (props, host) => untrack(() => AppSidebarContent(props, host)),
  {
    properties: appSidebarProperties,
    methods: {
      dismissTransientMenus: dismissSidebarTransientMenus,
      expandedAgentId: (host) => sidebarOwners.get(host)?.expandedAgentId() ?? "",
      findSidebarHovercardRowByKey: (host, key) =>
        sidebarOwners.get(host)?.findSidebarHovercardRowByKey(key),
      promoteCreatedSession: promoteSidebarCreatedSession,
    },
  },
);
