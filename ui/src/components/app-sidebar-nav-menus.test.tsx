import { createRoot } from "solid-js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import { createGateway, createSessions, mountSidebar } from "../test-helpers/app-sidebar.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import { mountSolid as render } from "../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import { SidebarDropdown, renderSidebarNavLink } from "./app-sidebar-nav-menus.tsx";
import { getAppSidebarOwner } from "./app-sidebar.tsx";
import {
  renderSidebarRailPinMenuForMenus,
  renderSidebarSessionMenuForMenus,
} from "./sidebar-menus-render.tsx";
import { createSidebarMenus, type SidebarMenus } from "./sidebar-menus.tsx";

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

it("keeps personal pinning and navigation usable in an offline session menu", async () => {
  const session = { key: "agent:main:review", sessionId: "review-id", label: "Review" };
  const pin = vi.fn();
  const menus = {
    sessionMenu: { x: 12, y: 30, session },
    pluginActionLifetime: new AbortController(),
    closeSessionMenu: vi.fn(),
    triggers: new Map(),
  } as unknown as SidebarMenus;
  const host = {
    connected: false,
    sessionDataContext: {
      gateway: { snapshot: { phase: "reconnecting", client: null, hello: null } },
      agents: { state: { agentsList: null } },
      sessions: { archiveVisibility: () => null },
    },
    sessionData: {
      sessionsResult: { sessions: [session] },
      sessionResultsByAgent: {},
      childSessionRowsByParent: {},
    },
    findSidebarMenuSessionByKey: () => session,
    selectedVisibleSessions: () => [],
    readSessionMutationAccess: () => ({ allowed: false, reason: "Reconnect" }),
    knownSessionGroups: () => [],
    sessionOrganizer: { isPersonalSessionPin: () => false, setPersonalSessionPin: pin },
  } as unknown as Parameters<typeof renderSidebarSessionMenuForMenus>[1];
  const view = render(() => renderSidebarSessionMenuForMenus(menus, host, menus.sessionMenu!));
  flush();
  const action = (value: string) =>
    view.container.querySelector<HTMLButtonElement>(`[data-value="${value}"]`)!;
  expect(action("rename").disabled).toBe(true);
  expect(action("toggle-unread").disabled).toBe(true);
  expect(action("copy-session-link").disabled).toBe(false);
  expect(action("toggle-pin").disabled).toBe(false);
  action("toggle-pin").click();
  await waitForSolid(() => expect(pin).toHaveBeenCalledExactlyOnceWith(session.key, true));
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

describe("sidebar rail pin menu", () => {
  setupSidebarTest();

  it.each([
    ["before", 1, "route:usage"],
    ["after", 1, "person:ada"],
    ["remove", 0, "route:usage"],
    ["remove", 2, "person:ada"],
  ] as const)(
    "closes the rail pin menu before %s dispatch at position %i",
    async (action, index, target) => {
      const entries: readonly [string, string, string] = [
        "route:usage",
        "route:sessions",
        "person:ada",
      ];
      const { sidebar } = await mountSidebar(
        createGateway(createTestGatewayClient(createGatewayRequestMock())),
        createSessions("main", []),
      );
      sidebar.sidebarEntries = entries;
      await sidebar.updateComplete;
      const host = getAppSidebarOwner(sidebar.hostElement)!;
      const pins = document.createElement("div");
      const { menus, disposeMenus } = createRoot((disposeRoot) => ({
        menus: createSidebarMenus({
          host,
          element: pins,
          commit: () => Promise.resolve(true),
        }),
        disposeMenus: disposeRoot,
      }));
      onTestFinished(disposeMenus);
      for (const entry of entries) {
        const pin = document.createElement("div");
        pin.className = "sidebar-rail__pin";
        pin.dataset.sidebarEntry = entry;
        pins.append(pin);
        menus.railPins.set(entry, pin);
      }
      const trigger = document.createElement("button");
      pins.append(trigger);
      document.body.append(pins);
      onTestFinished(() => pins.remove());
      menus.triggers.set("railPin", trigger);
      const position: NonNullable<SidebarMenus["railPinMenuPosition"]> = {
        x: 12,
        y: 30,
        entry: entries[index],
        label: "Pinned item",
      };
      const move = vi.spyOn(host.sessionOrganizer, "writeSidebarEntryAt").mockImplementation(() => {
        expect(menus.triggers.has("railPin")).toBe(false);
      });
      const remove = vi
        .spyOn(host.sessionOrganizer, "removeSidebarEntry")
        .mockImplementation(() => {
          expect(menus.triggers.has("railPin")).toBe(false);
        });
      const view = render(() => renderSidebarRailPinMenuForMenus(menus, host, position), {
        container: pins,
      });
      onTestFinished(() => view.unmount());
      flush();
      const menu = view.getByRole("menu", { hidden: true });
      expect(menu.querySelector('[data-value="before"]')?.hasAttribute("disabled")).toBe(
        index === 0,
      );
      expect(menu.querySelector('[data-value="after"]')?.hasAttribute("disabled")).toBe(
        index === 2,
      );
      expect(menus.triggers.get("railPin")).toBe(trigger);
      menu.querySelector<HTMLButtonElement>(`[data-value="${action}"]`)!.click();
      await waitForSolid(() => expect(action === "remove" ? remove : move).toHaveBeenCalledOnce());
      if (action === "remove") {
        expect(remove).toHaveBeenCalledExactlyOnceWith(target);
        expect(move).not.toHaveBeenCalled();
      } else {
        expect(move).toHaveBeenCalledExactlyOnceWith("route:sessions", target, action);
        expect(remove).not.toHaveBeenCalled();
      }
    },
  );
});
