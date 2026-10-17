import { getObserver } from "@solidjs/signals";
import { createComponent, createSignal } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import type { ControlUiHost, ControlUiNavigationItem } from "../../../src/plugin-sdk/control-ui.js";
import type { ApplicationContext } from "../app/context.ts";
import { SidebarMenusController } from "../components/sidebar-menus-controller.tsx";
import { Icon } from "../components/solid/icon.tsx";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import type { ControlUiRegistration } from "./control-ui-capability.ts";
import "./control-ui-view.solid.tsx";
import "./control-ui-contributions.solid.tsx";

const originalLocation = window.location.href;
afterEach(() => {
  document.body.replaceChildren();
  window.history.replaceState(null, "", originalLocation);
});

it("opens navigation actions through the sidebar menu owner for pointer and keyboard access", async () => {
  const run = vi.fn();
  const abort = new AbortController();
  const host = {
    navigation: { pageHref: () => "/boards" },
  } as unknown as ControlUiHost;
  const entries = ["boards", "child", "plain"].map((id) => ({
    key: `example/${id}`,
    pluginId: "example",
    signal: abort.signal,
    host,
    value: {
      id,
      label: id,
      page: { id: "boards" },
      ...(id === "child" ? { parent: "boards" } : {}),
      ...(id !== "plain"
        ? {
            actions: [
              { id: "delete", label: "Delete board…", icon: "trash", destructive: true, run },
            ],
          }
        : {}),
    },
  }));
  const provider = createApplicationContextProvider({
    plugins: { registrations: () => entries, subscribe: () => () => {} },
    router: { subscribe: () => () => {} },
  } as unknown as ApplicationContext);
  const [menuRevision, setMenuRevision] = createSignal(0);
  const controller = new SidebarMenusController({
    addController: vi.fn(),
    requestUpdate: () => setMenuRevision((revision) => revision + 1),
  } as unknown as ConstructorParameters<typeof SidebarMenusController>[0]);
  onTestFinished(() => controller.hostDisconnected());
  await controller.preloadMenuRenderer();
  const menuRoot = document.createElement("div");
  const contributions = ["boards", "child", "plain"].map((id) =>
    Object.assign(document.createElement("openclaw-plugin-contributions"), {
      kind: "navigation",
      navigationKey: `example/${id}`,
      navigationMenus: controller,
    }),
  );
  window.history.replaceState(null, "", "/boards");
  provider.append(...contributions, menuRoot);
  document.body.append(provider);
  await Promise.all(contributions.map((element) => element.updateComplete));
  // Project the standalone controller's updates as the sidebar host does.
  const menuView = new Proxy(controller, {
    get(target, key, receiver) {
      if (getObserver()) {
        menuRevision();
      }
      return Reflect.get(target, key, receiver);
    },
  });
  mountSolid(
    () => {
      controller.catalogMenuView = controller.catalogMenu.createView(controller.host);
      return menuView.render();
    },
    { container: menuRoot },
  );
  const [parent, pinned, plain] = contributions;
  const links = [
    parent!.querySelector("a")!,
    parent!.querySelector(".nav-item--child")!,
    pinned!.querySelector("a")!,
  ];
  const open = (link: Element, event: Event) => {
    link.dispatchEvent(event);
    flush();
    return menuRoot.querySelector<HTMLElement>(".sidebar-plugin-navigation-menu")!;
  };
  for (const [index, link] of links.entries()) {
    const menu = open(
      link,
      index === 0
        ? new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 24,
            clientY: 32,
          })
        : new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: index === 1 ? "F10" : "ContextMenu",
            shiftKey: index === 1,
          }),
    );
    expect(menu).not.toBeNull();
    expect(menu.parentElement?.querySelector<HTMLElement>(".oc-menu-trigger")?.style.left).toBe(
      index === 0 ? "24px" : "8px",
    );
    const item = menu.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    expect(item.textContent?.trim()).toBe("Delete board…");
    expect(item.classList.contains("session-menu__item--destructive")).toBe(true);
    expect(item.getAttribute("data-variant")).toBe("danger");
    expect(item.querySelector("svg")).not.toBeNull();
    item.click();
    await waitForSolid(() => expect(run).toHaveBeenCalledTimes(index + 1));
    flush();
    expect(menuRoot.querySelector(".sidebar-plugin-navigation-menu")).toBeNull();
  }
  const menu = open(links[0]!, new MouseEvent("contextmenu", { bubbles: true }));
  menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  flush();
  expect(menuRoot.querySelector(".sidebar-plugin-navigation-menu")).toBeNull();
  expect(document.activeElement).toBe(links[0]);
  open(links[0]!, new MouseEvent("contextmenu", { bubbles: true })).hidePopover();
  flush();
  expect(menuRoot.querySelector(".sidebar-plugin-navigation-menu")).toBeNull();

  for (const event of [
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true, cancelable: true }),
  ]) {
    expect(open(plain!.querySelector("a")!, event)).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  }
  const staleMenu = open(links[0]!, new MouseEvent("contextmenu", { bubbles: true }));
  const staleItem = staleMenu.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
  abort.abort();
  staleItem.click();
  expect(run).toHaveBeenCalledTimes(3);
});

it("shows the active plugin section's ordered children and leaves pinned children standalone", async () => {
  const listeners = new Set<() => void>();
  const openPage = vi.fn();
  const host = {
    navigation: {
      openPage,
      pageHref: (page: ControlUiNavigationItem["page"]) =>
        page.id === "special"
          ? "/special"
          : `/boards${page.params ? `?${new URLSearchParams(page.params)}` : ""}`,
    },
  } as unknown as ControlUiHost;
  const registration = (
    value: ControlUiNavigationItem,
    pluginId = "example",
  ): ControlUiRegistration<ControlUiNavigationItem> => ({
    key: `${pluginId}/${value.id}`,
    pluginId,
    signal: new AbortController().signal,
    host,
    value,
  });
  const entries = [
    registration({ id: "boards", label: "Boards", icon: "layers", page: { id: "boards" } }),
    registration({
      id: "zulu",
      parent: "boards",
      label: "Zulu",
      order: 2,
      page: { id: "boards", params: { board: "zulu" } },
    }),
    registration({
      id: "beta",
      parent: "boards",
      label: "Beta",
      order: 1,
      icon: "toString",
      page: { id: "special" },
    }),
    registration({
      id: "alpha",
      parent: "boards",
      label: "Alpha",
      order: 1,
      icon: "activity",
      page: { id: "boards", params: { board: "alpha" } },
    }),
    registration(
      { id: "foreign", parent: "boards", label: "Other plugin", page: { id: "boards" } },
      "other",
    ),
  ];
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const provider = createApplicationContextProvider({
    plugins: { registrations: () => entries, subscribe },
    router: { subscribe },
  } as unknown as ApplicationContext);
  const contribution = (key: string) =>
    Object.assign(document.createElement("openclaw-plugin-contributions"), {
      kind: "navigation",
      navigationKey: key,
    });
  const parent = contribution("example/boards");
  const pinned = contribution("example/alpha");
  provider.append(parent, pinned);
  window.history.replaceState(null, "", "/boards?board=alpha&filter=mine");
  document.body.append(provider);
  await parent.updateComplete;
  await pinned.updateComplete;

  const children = [...parent.querySelectorAll<HTMLAnchorElement>(".nav-item--child")];
  expect(children.map((child) => child.textContent?.trim())).toEqual(["Alpha", "Beta", "Zulu"]);
  expect(children.map((child) => child.getAttribute("aria-current"))).toEqual(["page", null, null]);
  const activityIcon = mountSolid(() => createComponent(Icon, { name: "activity" }), {
    container: document.createElement("div"),
  }).container;
  expect(
    [...children[0]!.querySelectorAll("svg path")].map((path) => path.getAttribute("d")),
  ).toEqual([...activityIcon.querySelectorAll("svg path")].map((path) => path.getAttribute("d")));
  const layersIcon = mountSolid(() => createComponent(Icon, { name: "layers" }), {
    container: document.createElement("div"),
  }).container;
  expect(
    [...children[1]!.querySelectorAll("svg path")].map((path) => path.getAttribute("d")),
  ).toEqual([...layersIcon.querySelectorAll("svg path")].map((path) => path.getAttribute("d")));
  expect(pinned.querySelectorAll("a")).toHaveLength(1);
  expect(pinned.querySelector(".nav-item--child")).toBeNull();
  expect(pinned.querySelector("a")?.getAttribute("aria-current")).toBe("page");
  children[1]!.click();
  expect(openPage).toHaveBeenCalledExactlyOnceWith({ id: "special" });

  for (const [location, activeChild, childCount] of [
    ["/special?filter=mine", "Beta", 3],
    ["/boards", undefined, 3],
    ["/elsewhere", undefined, 0],
  ] as const) {
    window.history.replaceState(null, "", location);
    for (const listener of listeners) {
      listener();
    }
    await parent.updateComplete;
    await pinned.updateComplete;
    expect(parent.querySelectorAll(".nav-item--child")).toHaveLength(childCount);
    expect(parent.querySelector('.nav-item--child[aria-current="page"]')?.textContent?.trim()).toBe(
      activeChild,
    );
  }
});
