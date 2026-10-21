/* @vitest-environment jsdom */

import { expect, it, onTestFinished, vi } from "vitest";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import {
  createGatewayBrowserClientFixture,
  createPaneHeaderWorkspaceFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
} from "./chat-pane.test-support.ts";
import {
  chatPaneHeaderSessionMenu,
  mountChatPaneHeader,
  renderPaneHeaderInto,
} from "./components/chat-pane-header.test-support.ts";
import type { SidebarPanelDefinition } from "./components/chat-sidebar-region-types.ts";
import { ensureSidebarConversation, openSlot, promoteSidebarPanel } from "./sidebar-layout.ts";

it("retains the plugin main selection when Panels closes and reopens offline", () => {
  const { pane, state } = createTestChatPane({
    client: createGatewayBrowserClientFixture(),
    sessions: createSessionCapabilityFixture(),
  });
  const slot = "plugin:fixture/notes";
  const definitions: SidebarPanelDefinition[] = [
    ...sidebarPanelDefinitions(),
    {
      slot,
      label: "Fixture notes",
      icon: sidebarPanelDefinitions()[0]!.icon,
      available: true,
      content: "Notes",
      loading: { variant: "files", label: "Loading notes" },
      empty: { description: "No notes" },
    },
  ];
  state.sidebarLayout = promoteSidebarPanel(
    openSlot(ensureSidebarConversation({ columns: [] }), slot),
    slot,
  );
  const columns = structuredClone(state.sidebarLayout.columns);
  const container = document.body.appendChild(document.createElement("div"));
  onTestFinished(() => container.remove());
  const paint = () => {
    renderPaneHeaderInto(
      pane.renderPaneHeader(
        createPaneHeaderWorkspaceFixture(state),
        { key: state.sessionKey, kind: "direct", updatedAt: 0 },
        false,
        undefined,
        false,
        null,
        state.sidebarLayout,
        definitions,
      ),
      container,
    );
    flush();
  };
  paint();
  const trigger = container.querySelector<HTMLButtonElement>(
    '.chat-pane__header button[aria-label="Panels"]',
  )!;
  expect(container.querySelectorAll(".chat-pane__header")).toHaveLength(1);
  expect(trigger).not.toBeNull();
  trigger.click();
  flush();
  expect(state.sidebarLayout.open).toBe(false);
  state.connected = false;
  paint();
  expect(container.querySelector('.chat-pane__header button[aria-label="Panels"]')).toBe(trigger);
  expect(trigger.disabled).toBe(false);
  trigger.click();
  flush();
  expect(state.sidebarLayout.open).toBe(true);
  expect(state.sidebarLayout.mainPanelId).toBe(slot);
  expect(state.sidebarLayout.columns).toEqual(columns);
});

it("retains focused session menu controls through header refresh and restores focus before splitting", async () => {
  const focusAtSplit: (Element | null)[] = [];
  const onSplitRight = vi.fn<(paneId: string) => void>(() => {
    focusAtSplit.push(document.activeElement);
  });
  const sidebarLayout = () => openSlot({ columns: [] }, "workspace");
  const mounted = mountChatPaneHeader([], {
    onClosePane: vi.fn(),
    onSplitRight,
    sessionMenuAction: {
      ...chatPaneHeaderSessionMenu(),
      session: { ...chatPaneHeaderSessionMenu().session, target: { key: "agent:main:test" } },
      splitAllowed: true,
    },
    sidebarLayout: sidebarLayout(),
    panelDefinitions: sidebarPanelDefinitions(),
    onLayoutChange: vi.fn(),
  });
  onTestFinished(() => {
    mounted.unmount();
    mounted.container.remove();
  });
  const menu = mounted.container.querySelector("openclaw-chat-header-session-menu")!;
  await menu.updateComplete;
  const trigger = menu.querySelector<HTMLButtonElement>(".chat-header-session-menu__trigger")!;
  trigger.click();
  await waitForSolid(() =>
    expect(menu.querySelector(".chat-header-session-menu__panel")?.matches(":popover-open")).toBe(
      true,
    ),
  );
  menu.querySelector<HTMLButtonElement>('[data-value="submenu:advanced"]')!.click();
  await waitForSolid(() =>
    expect(menu.querySelector('[data-value="submenu:open-in"]')).not.toBeNull(),
  );
  const openIn = menu.querySelector<HTMLButtonElement>('[data-value="submenu:open-in"]')!;
  openIn.click();
  await waitForSolid(() => expect(menu.querySelector('[data-value="split-right"]')).not.toBeNull());
  const split = menu.querySelector<HTMLButtonElement>('[data-value="split-right"]')!;
  split.focus();
  mounted.update({
    title: "Updated session title",
    sidebarLayout: sidebarLayout(),
    panelDefinitions: sidebarPanelDefinitions(),
  });
  await menu.updateComplete;
  expect(mounted.container.querySelector("openclaw-chat-header-session-menu")).toBe(menu);
  expect(menu.querySelector(".chat-header-session-menu__trigger")).toBe(trigger);
  expect(menu.querySelector('[data-value="submenu:open-in"]')).toBe(openIn);
  expect(menu.querySelector('[data-value="split-right"]')).toBe(split);
  expect(document.activeElement).toBe(split);
  expect(split.closest('[role="menu"]')?.matches(":popover-open")).toBe(true);
  split.click();
  await waitForSolid(() =>
    expect(menu.querySelector(".chat-header-session-menu__panel")?.matches(":popover-open")).toBe(
      false,
    ),
  );
  expect(document.activeElement).toBe(trigger);
  expect(focusAtSplit).toEqual([trigger]);
  expect(onSplitRight).toHaveBeenCalledExactlyOnceWith("pane-1");
});

it("renders a native external link in the main panel header", () => {
  const panelDefinitions = sidebarPanelDefinitions();
  panelDefinitions.find((definition) => definition.slot === "workspace")!.headerLink = {
    href: "https://example.test/panel",
    label: "Open panel",
  };
  const mounted = mountChatPaneHeader([], {
    sidebarLayout: promoteSidebarPanel(openSlot({ columns: [] }, "workspace"), "workspace"),
    panelDefinitions,
    panelActionDestinations: { main: true, side: false, dashboard: false },
  });
  onTestFinished(mounted.unmount);
  const link = mounted.container.querySelector<HTMLAnchorElement>('a[aria-label="Open panel"]')!;
  expect(link).not.toBeNull();
  expect(link.href).toBe("https://example.test/panel");
  expect(link.target).toBe("_blank");
  expect(link.rel).toBe("noopener");
  expect(link.closest(".chat-pane__header")).not.toBeNull();
});
