import type WaDropdownItem from "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid as render } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import {
  renderSidebarCustomizeMenu,
  SidebarDropdown,
  renderSidebarNavLink,
  renderSidebarMoreMenu,
} from "./app-sidebar-nav-menus.tsx";

it("keeps modified sidebar links native and handles ordinary navigation", () => {
  const navigate = vi.fn();
  const view = render(() =>
    renderSidebarNavLink({
      href: "/sessions",
      active: true,
      icon: <span>Sessions icon</span>,
      label: "Sessions",
      onNavigate: navigate,
    }),
  );
  flush();
  const link = view.getByRole("link", { name: "Sessions" });
  expect(link.getAttribute("aria-current")).toBe("page");

  const modified = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
  link.dispatchEvent(modified);
  expect(modified.defaultPrevented).toBe(false);
  expect(navigate).not.toHaveBeenCalled();

  const ordinary = new MouseEvent("click", { bubbles: true, cancelable: true });
  link.dispatchEvent(ordinary);
  expect(ordinary.defaultPrevented).toBe(true);
  expect(navigate).toHaveBeenCalledOnce();
});

it("preserves native modified clicks before the More menu emits its selection", async () => {
  const navigate = vi.fn();
  const view = render(() =>
    renderSidebarMoreMenu({
      position: { x: 12, y: 30 },
      basePath: "",
      activeRouteId: undefined,
      sidebarEntries: [],
      isRouteEnabled: (route) => route === "usage",
      onNavigateRoute: navigate,
      onPreloadRoute: vi.fn(),
      onCancelPreload: vi.fn(),
      onEditPinnedItems: vi.fn(),
      onTabAway: vi.fn(),
      onClose: vi.fn(),
    }),
  );
  flush();
  const item = view.container.querySelector<WaDropdownItem>('wa-dropdown-item[value="usage"]')!;
  await item.updateComplete;
  const link = item.querySelector("a")!;
  for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, ...modifier });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  }
  link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  expect(navigate).toHaveBeenCalledExactlyOnceWith("usage");
});

it("delivers the Web Awesome selection event from the Solid dropdown", () => {
  const select = vi.fn();
  const view = render(() => (
    <SidebarDropdown
      position={{ x: 12, y: 30 }}
      class="sidebar-menu-test"
      label="Sidebar actions"
      onSelect={select}
      onTabAway={vi.fn()}
      onClose={vi.fn()}
      content={<span>Actions</span>}
    />
  ));
  flush();
  const dropdown = view.container.querySelector("wa-dropdown");
  expect(dropdown).not.toBeNull();
  const item = Object.assign(document.createElement("div"), { value: "customize" });
  const event = new CustomEvent("wa-select", {
    bubbles: true,
    cancelable: true,
    detail: { item },
  });
  dropdown!.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(select).toHaveBeenCalledExactlyOnceWith(item);
});

it("keeps the focused pin choice mounted while live availability and selection update", () => {
  const [enabled, setEnabled] = createSignal(["usage"]);
  const [entries, setEntries] = createSignal<string[]>([]);
  const view = render(() =>
    renderSidebarCustomizeMenu({
      position: { x: 12, y: 30 },
      get sidebarEntries() {
        return entries();
      },
      preferencesBrowserOnly: false,
      isRouteEnabled: (route) => enabled().includes(route),
      pluginNavigation: [],
      onToggleRoute: vi.fn(),
      onTogglePlugin: vi.fn(),
      onReset: vi.fn(),
      onTabAway: vi.fn(),
      onClose: vi.fn(),
    }),
  );
  flush();
  const item = view.container.querySelector<HTMLElement & { checked: boolean }>(
    'wa-dropdown-item[value="usage"]',
  )!;
  expect(item).not.toBeNull();
  item.tabIndex = 0;
  item.focus();

  setEnabled(["usage", "sessions"]);
  setEntries(["route:usage"]);
  flush();

  expect(view.container.querySelector('wa-dropdown-item[value="usage"]')).toBe(item);
  expect(document.activeElement).toBe(item);
  expect(item.checked).toBe(true);
});
