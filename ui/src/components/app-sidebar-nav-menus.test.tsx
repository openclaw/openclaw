import { expect, it, onTestFinished, vi } from "vitest";
import { mountSolid as render } from "../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
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

it("delivers an action selected through the shared sidebar menu", async () => {
  const select = vi.fn();
  const view = render(() => (
    <SidebarDropdown
      position={{ x: 12, y: 30 }}
      class="sidebar-menu-test"
      label="Sidebar actions"
      onSelect={select}
      onClose={vi.fn()}
      items={[{ id: "customize", label: "Customize" }]}
    />
  ));
  await waitForSolid(() =>
    expect(view.container.querySelector("[role=menu]")!.matches(":popover-open")).toBe(true),
  );
  view.getByRole("menuitem", { name: "Customize", hidden: true }).click();
  await waitForSolid(() => expect(select).toHaveBeenCalledExactlyOnceWith("customize"));
});

it("retires sidebar hover callbacks with the mounted menu", async () => {
  const enter = vi.fn();
  const leave = vi.fn();
  const view = render(() => (
    <SidebarDropdown
      position={{ x: 12, y: 30 }}
      class="sidebar-menu-test"
      label="Sidebar actions"
      onSelect={vi.fn()}
      onClose={vi.fn()}
      onPointerEnter={enter}
      onPointerLeave={leave}
      items={[{ id: "customize", label: "Customize" }]}
    />
  ));
  const menu = view.getByRole("menu", { hidden: true });
  menu.dispatchEvent(new Event("pointerenter"));
  menu.dispatchEvent(new Event("pointerleave"));
  expect(enter).toHaveBeenCalledOnce();
  expect(leave).toHaveBeenCalledOnce();

  view.unmount();
  menu.dispatchEvent(new Event("pointerenter"));
  menu.dispatchEvent(new Event("pointerleave"));
  expect(enter).toHaveBeenCalledOnce();
  expect(leave).toHaveBeenCalledOnce();
});

it("returns to the durable trigger without consuming native Tab", async () => {
  const anchor = document.createElement("button");
  document.body.append(anchor);
  onTestFinished(() => anchor.remove());
  const close = vi.fn();
  const view = render(() => (
    <SidebarDropdown
      position={{ x: 12, y: 30 }}
      class="sidebar-menu-test"
      label="Sidebar actions"
      anchor={anchor}
      onSelect={vi.fn()}
      onClose={close}
      items={[{ id: "customize", label: "Customize" }]}
    />
  ));
  const item = view.getByRole("menuitem", { name: "Customize", hidden: true });
  await waitForSolid(() => expect(document.activeElement).toBe(item));
  const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  item.dispatchEvent(tab);
  expect(tab.defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(anchor);
  expect(close).toHaveBeenCalledExactlyOnceWith(false);
});

it.each([
  ["before", 1, "route:usage"],
  ["after", 1, "person:ada"],
  ["remove", 0, "route:usage"],
  ["remove", 2, "person:ada"],
] as const)(
  "closes the rail pin menu before %s dispatch at position %i",
  async (action, index, target) => {
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
      positionedMenuHandlers: (_menu: "railPin") => ({ onClose() {} }),
    } as SidebarMenusController;
    const view = render(() => renderSidebarRailPinMenuForController(controller), {
      container: pins,
    });
    flush();
    const menu = view.getByRole("menu", { hidden: true });
    expect(menu.querySelector('[data-value="before"]')?.hasAttribute("disabled")).toBe(index === 0);
    expect(menu.querySelector('[data-value="after"]')?.hasAttribute("disabled")).toBe(index === 2);
    menu.querySelector<HTMLButtonElement>(`[data-value="${action}"]`)!.click();
    await waitForSolid(() => expect(calls).toHaveLength(2));
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
