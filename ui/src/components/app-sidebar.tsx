import { render, type JSX } from "@solidjs/web";
import { createEffect, getOwner, onCleanup, onSettled, runWithOwner, Show } from "solid-js";
import { useApplication } from "../lib/reactive/context.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import type { AppSidebarProps } from "./app-sidebar-base.ts";
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

export function AppSidebarContent(props: AppSidebarProps, host: () => HTMLElement): JSX.Element {
  const owner = new AppSidebarOwner(props, useApplication());
  const projection = projectSource(owner, {
    read: (current) => current,
    subscribe: (current, notify) => current.subscribe(notify),
    equality: "revision",
  });
  const observe = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(current, key, receiver) {
        projection.revision();
        return key === "host" ? hostView : Reflect.get(current, key, receiver);
      },
    });
  const observedCatalogMenu = observe(owner.sidebarMenus.catalogMenu);
  const observedMenus = new Proxy(owner.sidebarMenus, {
    get(current, key, receiver) {
      projection.revision();
      if (key === "host") {
        return hostView;
      }
      return key === "catalogMenu" ? observedCatalogMenu : Reflect.get(current, key, receiver);
    },
  });
  const observedControllers = {
    sidebarMenus: observedMenus,
    sessionData: observe(owner.sessionData),
    sessionOrganizer: observe(owner.sessionOrganizer),
    people: observe(owner.people),
  };
  const hostView: AppSidebarOwner = new Proxy(owner, {
    get(current, key, receiver) {
      projection.revision();
      if (key === "sidebarMenus") {
        return observedControllers.sidebarMenus;
      }
      if (key === "sessionData") {
        return observedControllers.sessionData;
      }
      if (key === "sessionOrganizer") {
        return observedControllers.sessionOrganizer;
      }
      if (key === "people") {
        return observedControllers.people;
      }
      return Reflect.get(current, key, receiver);
    },
  });
  const view = () => hostView;
  const solidOwner = getOwner();
  const mountDefaultView = (target: HTMLElement) =>
    runWithOwner(solidOwner, () => render(() => hostView.renderSessionsBody(), target));
  const SessionBody = () => hostView.renderSessionsBody();
  const sessions = (
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
  const content = hostView.renderSidebar(view, sessions);
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
    attachedHost = host();
    sidebarOwners.set(attachedHost, owner);
    owner.attach(attachedHost);
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

export function AppSidebar(props: AppSidebarProps): JSX.Element {
  let host!: HTMLElement;
  const content = AppSidebarContent(props, () => host);
  return (
    <openclaw-app-sidebar
      ref={(element) => {
        host = element;
      }}
      style={{ display: "contents" }}
    >
      {content}
    </openclaw-app-sidebar>
  );
}
