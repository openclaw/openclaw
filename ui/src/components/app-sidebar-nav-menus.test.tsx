import { expect, it, onTestFinished, vi } from "vitest";
import { mountSolid as render } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { SidebarDropdown, renderSidebarNavLink } from "./app-sidebar-nav-menus.tsx";
import type { SidebarMenusController } from "./sidebar-menus-controller.tsx";
import { renderSidebarRailPinMenuForController } from "./sidebar-menus-render.tsx";

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

it.each([
  ["before", 1, "route:usage"],
  ["after", 1, "person:ada"],
  ["remove", 0, "route:usage"],
  ["remove", 2, "person:ada"],
] as const)(
  "closes the rail pin menu before %s dispatch at position %i",
  (action, index, target) => {
    const entries: readonly string[] = ["route:usage", "route:sessions", "person:ada"];
    const pins = document.createElement("div");
    for (const entry of entries) {
      const pin = document.createElement("div");
      pin.className = "sidebar-rail__pin";
      pin.dataset.sidebarEntry = entry;
      pins.append(pin);
    }
    document.body.append(pins);
    onTestFinished(() => pins.remove());
    const calls: string[] = [];
    const move = vi.fn();
    const remove = vi.fn();
    const controller = {
      railPinMenuPosition: { x: 12, y: 30, entry: entries[index], label: "Pinned item" },
      railPinMenuTrigger: null,
      host: {
        sidebarEntries: entries,
        querySelectorAll: pins.querySelectorAll.bind(pins),
        updateComplete: Promise.resolve(true),
        sessionOrganizer: {
          writeSidebarEntryAt(entry: string, neighbor: string, position: string) {
            calls.push("move");
            move(entry, neighbor, position);
          },
          removeSidebarEntry(entry: string) {
            calls.push("remove");
            remove(entry);
          },
        },
      },
      closePositionedMenu(_menu: "railPin") {
        calls.push("close");
      },
      positionedMenuHandlers: (_menu: "railPin") => ({ onTabAway() {}, onClose() {} }),
    } as SidebarMenusController;
    const view = render(() => renderSidebarRailPinMenuForController(controller), {
      container: pins,
    });
    flush();
    const menu = view.container.querySelector("wa-dropdown")!;
    expect(menu.querySelector('[value="before"]')?.hasAttribute("disabled")).toBe(index === 0);
    expect(menu.querySelector('[value="after"]')?.hasAttribute("disabled")).toBe(index === 2);
    menu.dispatchEvent(
      new CustomEvent("wa-select", {
        bubbles: true,
        cancelable: true,
        detail: { item: menu.querySelector(`[value="${action}"]`) },
      }),
    );
    if (action === "remove") {
      expect(remove).toHaveBeenCalledExactlyOnceWith(target);
      expect(move).not.toHaveBeenCalled();
      expect(calls).toEqual(["close", "remove"]);
    } else {
      expect(move).toHaveBeenCalledExactlyOnceWith("route:sessions", target, action);
      expect(remove).not.toHaveBeenCalled();
      expect(calls).toEqual(["close", "move"]);
    }
  },
);
