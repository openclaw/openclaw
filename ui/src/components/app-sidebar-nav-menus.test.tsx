import { createRoot, createSignal } from "solid-js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { de } from "../i18n/locales/de.ts";
import { createIdentityAvatars } from "../lib/identity-avatar-loader.ts";
import { projectOwner } from "../lib/reactive/projection.ts";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import { createGateway, createSessions, mountSidebar } from "../test-helpers/app-sidebar.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import { mountSolid as render } from "../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import { renderSidebarAgentMenu as AgentMenu } from "./app-sidebar-agent-menu.tsx";
import { SidebarDropdown, type SidebarDropdownProps } from "./app-sidebar-dropdown.tsx";
import { renderSidebarNavLink } from "./app-sidebar-nav-menus.tsx";
import { renderSidebarSessionSectionHeader as SectionHeader } from "./app-sidebar-session-section-header.tsx";
import { getAppSidebarOwner } from "./app-sidebar.tsx";
import { SessionOrganizer } from "./session-organizer.ts";
import { SidebarMenusRenderer } from "./sidebar-menus-render.tsx";
import type { SidebarMenusOwner } from "./sidebar-menus-types.ts";
import { createSidebarMenus, type SidebarMenus } from "./sidebar-menus.tsx";

it("updates retained agent creation menu labels when the locale changes", async () => {
  await i18n.setLocale("en");
  onTestFinished(async () => {
    await i18n.setLocale("en");
    i18n.registerTranslation("de", de);
  });
  // This new action does not have a foreign catalog translation yet.
  i18n.registerTranslation("de", {
    ...de,
    agentChip: { createAgent: "Neuen Agenten erstellen" },
  });
  const view = render(() => (
    <AgentMenu
      activeId="main"
      agents={[]}
      identities={new Map()}
      openMode="click"
      position={{ x: 12, top: 30 }}
      basePath=""
      rosterMode={false}
      creationDisabledReason={null}
      resolveAvatarUrl={(url) => url}
      avatarErrorHandler={() => vi.fn()}
      agentUnreadCount={() => 0}
      onShowAllAgents={vi.fn()}
      onCreateAgent={vi.fn()}
      onPointerEnter={vi.fn()}
      onPointerLeave={vi.fn()}
      onAfterShow={vi.fn()}
      onSwitchAgent={vi.fn()}
      onClose={vi.fn()}
      onNavigate={vi.fn()}
    />
  ));
  flush();
  const menu = view.getByRole("menu", { hidden: true });
  const row = view.getByRole("menuitem", { name: "Create new agent", hidden: true });
  expect(row.getAttribute("data-value")).toBe("command:new-agent");

  await i18n.setLocale("de");
  await waitForSolid(() => {
    expect(row.getAttribute("aria-label")).toBe("Neuen Agenten erstellen");
    expect(row.textContent?.trim()).toBe("Neuen Agenten erstellen");
    expect(menu.querySelector('[data-value="command:new-agent"]')).toBe(row);
  });
  expect(view.getByRole("menu", { hidden: true })).toBe(menu);
});

const position = { x: 12, y: 30 };
function dropdown(overrides: Partial<SidebarDropdownProps>) {
  return render(() => (
    <SidebarDropdown
      position={position}
      class="sidebar-menu-test"
      label="Sidebar actions"
      onSelect={vi.fn()}
      onClose={vi.fn()}
      items={[{ id: "customize", label: "Customize" }]}
      {...overrides}
    />
  ));
}

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

it("uses current section actions while retaining the header", () => {
  const initialToggle = vi.fn();
  const currentToggle = vi.fn();
  const initialContext = vi.fn();
  const currentContext = vi.fn();
  const [current, setCurrent] = createSignal(false);
  const view = render(() => (
    <SectionHeader
      sectionId="work"
      sectionHeaders={new Map()}
      content="Work"
      draggable={false}
      onStartDrag={vi.fn()}
      onFinishDrag={vi.fn()}
      onContextMenu={current() ? currentContext : initialContext}
      status={{
        content: "Expand",
        label: "Expand work",
        expanded: false,
        onToggle: current() ? currentToggle : initialToggle,
      }}
    />
  ));
  const button = view.getByRole("button", { name: "Expand work" });
  const header = button.parentElement!;
  setCurrent(true);
  flush();
  button.click();
  header.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  expect(currentToggle).toHaveBeenCalledOnce();
  expect(currentContext).toHaveBeenCalledOnce();
  expect(initialToggle).not.toHaveBeenCalled();
  expect(initialContext).not.toHaveBeenCalled();
  expect(view.getByRole("button", { name: "Expand work" })).toBe(button);
});

it("keeps personal pinning and navigation usable in an offline session menu", async () => {
  const session = { key: "agent:main:review", sessionId: "review-id", label: "Review" };
  const pin = vi.fn();
  const menus = {
    sessionMenu: { ...position, session },
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
    sessionOrganizer: {
      isPersonalSessionPin: () => false,
      setPersonalSessionPin: pin,
      runSessionAction(...args: Parameters<SessionOrganizer["runSessionAction"]>) {
        return SessionOrganizer.prototype.runSessionAction.call(this, ...args);
      },
    },
  } as unknown as SidebarMenusOwner;
  const view = render(() => (
    <SidebarMenusRenderer
      menus={menus}
      host={host}
      avatars={createIdentityAvatars()}
      revision={() => 0}
    />
  ));
  const action = (value: string) =>
    view.container.querySelector<HTMLButtonElement>(`[data-value="${value}"]`)!;
  await waitForSolid(() => expect(action("rename")).not.toBeNull());
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
  const view = dropdown({ onPointerEnter: enter, onPointerLeave: leave });
  const menu = view.getByRole("menu", { hidden: true });
  for (const mounted of [true, false]) {
    if (!mounted) {
      view.unmount();
    }
    menu.dispatchEvent(new Event("pointerenter"));
    menu.dispatchEvent(new Event("pointerleave"));
    expect(enter).toHaveBeenCalledOnce();
    expect(leave).toHaveBeenCalledOnce();
  }
});

it("returns to the durable trigger without consuming native Tab", async () => {
  const anchor = document.createElement("button");
  document.body.append(anchor);
  onTestFinished(() => anchor.remove());
  const close = vi.fn();
  const view = dropdown({ anchor, onClose: close });
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
      const warnings = vi.spyOn(console, "warn");
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
      menus.openRailPinMenu(entries[index], "Pinned item", position.x, position.y, trigger);
      const move = vi.spyOn(host.sessionOrganizer, "writeSidebarEntryAt").mockImplementation(() => {
        expect(menus.triggers.has("railPin")).toBe(false);
      });
      const remove = vi
        .spyOn(host.sessionOrganizer, "removeSidebarEntry")
        .mockImplementation(() => {
          expect(menus.triggers.has("railPin")).toBe(false);
        });
      const view = render(
        () => {
          const projection = projectOwner(menus, (owner) => owner);
          return (
            <SidebarMenusRenderer
              menus={menus}
              host={host}
              avatars={createIdentityAvatars()}
              revision={projection.revision}
            />
          );
        },
        { container: pins },
      );
      onTestFinished(() => view.unmount());
      await waitForSolid(() => expect(view.queryByRole("menu", { hidden: true })).not.toBeNull());
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
      expect(
        warnings.mock.calls.filter(
          ([message]) => typeof message === "string" && message.includes("[NO_OWNER_EFFECT]"),
        ),
      ).toEqual([]);
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
