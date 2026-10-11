import { render } from "lit";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import type { ControlUiHost, ControlUiNavigationItem } from "../../../src/plugin-sdk/control-ui.js";
import type { ApplicationContext } from "../app/context.ts";
import { icons } from "../components/icons.ts";
import { SidebarMenusController } from "../components/sidebar-menus-controller.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import type { ControlUiRegistration } from "./control-ui-capability.ts";
import "./control-ui-view.runtime.tsx";
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
  const controller = new SidebarMenusController({
    addController: vi.fn(),
    requestUpdate: vi.fn(),
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
  const [parent, pinned, plain] = contributions;
  const links = [
    parent!.querySelector("a")!,
    parent!.querySelector(".nav-item--child")!,
    pinned!.querySelector("a")!,
  ];
  const open = (link: Element, event: Event) => {
    link.dispatchEvent(event);
    render(controller.render(), menuRoot);
    return menuRoot.querySelector(".sidebar-plugin-navigation-menu")!;
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
    expect(menu.querySelector("button")?.style.left).toBe(index === 0 ? "24px" : "8px");
    const item = menu.querySelector("wa-dropdown-item")!;
    expect(item.textContent?.trim()).toBe("Delete board…");
    expect(item.classList.contains("session-menu__item--destructive")).toBe(true);
    expect(item.getAttribute("variant")).toBe("danger");
    expect(item.querySelector("svg")).not.toBeNull();
    menu.dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value: "delete" } } }));
    expect(run).toHaveBeenCalledTimes(index + 1);
    render(controller.render(), menuRoot);
    expect(menuRoot.querySelector("wa-dropdown")).toBeNull();
  }
  const menu = open(links[0]!, new MouseEvent("contextmenu", { bubbles: true }));
  menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  menu.dispatchEvent(new CustomEvent("wa-after-hide"));
  render(controller.render(), menuRoot);
  expect(menuRoot.querySelector("wa-dropdown")).toBeNull();
  expect(document.activeElement).toBe(links[0]);
  open(links[0]!, new MouseEvent("contextmenu", { bubbles: true })).dispatchEvent(
    new CustomEvent("wa-after-hide"),
  );
  render(controller.render(), menuRoot);
  expect(menuRoot.querySelector("wa-dropdown")).toBeNull();

  for (const event of [
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true, cancelable: true }),
  ]) {
    expect(open(plain!.querySelector("a")!, event)).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  }
  const staleMenu = open(links[0]!, new MouseEvent("contextmenu", { bubbles: true }));
  abort.abort();
  staleMenu.dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value: "delete" } } }));
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
  const icon = document.createElement("div");
  render(icons.activity, icon);
  expect(
    [...children[0]!.querySelectorAll("svg path")].map((path) => path.getAttribute("d")),
  ).toEqual([...icon.querySelectorAll("svg path")].map((path) => path.getAttribute("d")));
  render(icons.layers, icon);
  expect(
    [...children[1]!.querySelectorAll("svg path")].map((path) => path.getAttribute("d")),
  ).toEqual([...icon.querySelectorAll("svg path")].map((path) => path.getAttribute("d")));
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
