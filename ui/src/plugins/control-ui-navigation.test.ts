import { createRoot, onCleanup } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import type { ControlUiHost, ControlUiNavigationItem } from "../../../src/plugin-sdk/control-ui.js";
import type { ApplicationContext } from "../app/context.ts";
import { iconData } from "../components/icon-data.ts";
import type { SidebarMenusOwner } from "../components/sidebar-menus-types.ts";
import { createSidebarMenus } from "../components/sidebar-menus.tsx";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import type { ControlUiRegistration } from "./control-ui-capability.ts";
import "./control-ui-contributions.solid.tsx";

const originalLocation = window.location.href;
const pointer = (init: MouseEventInit = {}) =>
  new MouseEvent("contextmenu", { bubbles: true, cancelable: true, ...init });
const keyboard = (key: string, init: KeyboardEventInit = {}) =>
  new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...init });
const registrations =
  (navigation: Partial<ControlUiHost["navigation"]>, signal = new AbortController().signal) =>
  (
    id: string,
    value: Partial<ControlUiNavigationItem> = {},
    pluginId = "example",
  ): ControlUiRegistration<ControlUiNavigationItem> => ({
    key: `${pluginId}/${id}`,
    pluginId,
    signal,
    host: { navigation } as unknown as ControlUiHost,
    value: { id, label: id, page: { id: "boards" }, ...value },
  });
const contribution = (key: string) =>
  Object.assign(document.createElement("openclaw-plugin-contributions"), {
    kind: "navigation",
    navigationKey: `example/${key}`,
  });
const providerFor = (
  entries: ControlUiRegistration<ControlUiNavigationItem>[],
  subscribe = (_listener: () => void) => () => {},
) =>
  createApplicationContextProvider({
    plugins: { registrations: () => entries, subscribe },
    router: { subscribe },
  } as unknown as ApplicationContext);
const expectIcon = (element: Element, name: "activity" | "layers") =>
  expect([...element.querySelectorAll("svg path")].map((path) => path.getAttribute("d"))).toEqual(
    iconData[name].children.filter(([tag]) => tag === "path").map(([, attrs]) => attrs.d),
  );
afterEach(() => {
  document.body.replaceChildren();
  window.history.replaceState(null, "", originalLocation);
});

it("opens navigation actions through the sidebar menu owner for pointer and keyboard access", async () => {
  const run = vi.fn();
  const abort = new AbortController();
  const entry = registrations({ pageHref: () => "/boards" }, abort.signal);
  const actions = [{ id: "delete", label: "Delete board…", icon: "trash", destructive: true, run }];
  const entries = [
    entry("boards", { actions }),
    entry("child", { parent: "boards", actions }),
    entry("plain"),
  ];
  const menuRoot = document.createElement("div");
  const menuHost = {} as SidebarMenusOwner;
  const menus = createRoot((dispose) => {
    onTestFinished(dispose);
    return createSidebarMenus({ host: menuHost, element: menuRoot, commit: async () => true });
  });
  await menus.preloadMenuRenderer();
  const provider = providerFor(entries);
  const contributions = entries.map(({ value }) =>
    Object.assign(contribution(value.id), { navigationMenus: menus }),
  );
  provider.append(...contributions, menuRoot);
  window.history.replaceState(null, "", "/boards");
  document.body.append(provider);
  await Promise.all(contributions.map((element) => element.updateComplete));
  mountSolid(
    () => {
      onCleanup(menus.bindCatalogMenuView(menus.catalogMenu.createView(menuHost)));
      return menus.render(menuHost);
    },
    { container: menuRoot },
  );
  const [parent, pinned, plain] = contributions;
  const links = [...parent!.querySelectorAll("a"), pinned!.querySelector("a")!];
  expect(links).toHaveLength(3);
  expect(links[1]?.classList.contains("nav-item--child")).toBe(true);
  const open = (link: Element, event: Event) => {
    link.dispatchEvent(event);
    flush();
    return menuRoot.querySelector<HTMLElement>(".sidebar-plugin-navigation-menu")!;
  };
  const currentMenu = () => menuRoot.querySelector(".sidebar-plugin-navigation-menu");
  for (const [index, event] of [
    pointer({ clientX: 24, clientY: 32 }),
    keyboard("F10", { shiftKey: true }),
    keyboard("ContextMenu"),
  ].entries()) {
    const menu = open(links[index]!, event);
    const trigger = menu.parentElement?.querySelector<HTMLElement>(".oc-menu-trigger");
    expect(trigger?.style.left).toBe(index === 0 ? "24px" : "8px");
    const item = menu.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    expect(item.textContent?.trim()).toBe("Delete board…");
    expect(item).toMatchObject({ dataset: { variant: "danger" } });
    expect(item.classList.contains("session-menu__item--destructive")).toBe(true);
    expect(item.querySelector("svg")).not.toBeNull();
    item.click();
    await waitForSolid(() => expect(run).toHaveBeenCalledTimes(index + 1));
    flush();
    expect(currentMenu()).toBeNull();
  }
  const menu = open(links[0]!, pointer());
  menu.dispatchEvent(keyboard("Escape"));
  flush();
  expect(currentMenu()).toBeNull();
  expect(document.activeElement).toBe(links[0]);
  open(links[0]!, pointer()).hidePopover();
  flush();
  expect(currentMenu()).toBeNull();

  for (const event of [pointer(), keyboard("ContextMenu")]) {
    expect(open(plain!.querySelector("a")!, event)).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  }
  const staleMenu = open(links[0]!, pointer());
  const staleItem = staleMenu.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
  abort.abort();
  staleItem.click();
  expect(run).toHaveBeenCalledTimes(3);
});

it("shows the active plugin section's ordered children and leaves pinned children standalone", async () => {
  const listeners = new Set<() => void>();
  const openPage = vi.fn();
  const registration = registrations({
    openPage,
    pageHref: ({ id, params }) => `/${id}${params ? `?${new URLSearchParams(params)}` : ""}`,
  });
  const childEntry = (
    id: string,
    order: number,
    icon: string | undefined,
    page: ControlUiNavigationItem["page"] = { id: "boards", params: { board: id } },
  ) => registration(id, { parent: "boards", order, icon, page });
  const entries = [
    registration("boards", { icon: "layers" }),
    childEntry("zulu", 2, undefined),
    childEntry("beta", 1, "toString", { id: "special" }),
    childEntry("alpha", 1, "activity"),
    registration("foreign", { parent: "boards" }, "other"),
  ];
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const provider = providerFor(entries, subscribe);
  const parent = contribution("boards");
  const pinned = contribution("alpha");
  provider.append(parent, pinned);
  window.history.replaceState(null, "", "/boards?board=alpha&filter=mine");
  document.body.append(provider);
  await Promise.all([parent.updateComplete, pinned.updateComplete]);

  const children = [...parent.querySelectorAll<HTMLAnchorElement>(".nav-item--child")];
  expect(children.map((child) => child.textContent?.trim())).toEqual(["alpha", "beta", "zulu"]);
  expect(children.map((child) => child.getAttribute("aria-current"))).toEqual(["page", null, null]);
  expectIcon(children[0]!, "activity");
  expectIcon(children[1]!, "layers");
  expect(pinned.querySelectorAll("a")).toHaveLength(1);
  expect(pinned.querySelector(".nav-item--child")).toBeNull();
  expect(pinned.querySelector("a")?.getAttribute("aria-current")).toBe("page");
  children[1]!.click();
  expect(openPage).toHaveBeenCalledExactlyOnceWith({ id: "special" });

  for (const [location, activeChild, childCount] of [
    ["/special?filter=mine", "beta", 3],
    ["/boards", undefined, 3],
    ["/elsewhere", undefined, 0],
  ] as const) {
    window.history.replaceState(null, "", location);
    listeners.forEach((listener) => listener());
    await Promise.all([parent.updateComplete, pinned.updateComplete]);
    expect(parent.querySelectorAll(".nav-item--child")).toHaveLength(childCount);
    expect(parent.querySelector('.nav-item--child[aria-current="page"]')?.textContent?.trim()).toBe(
      activeChild,
    );
  }
});
