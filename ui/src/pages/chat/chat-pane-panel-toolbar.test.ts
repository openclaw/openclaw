/* @vitest-environment jsdom */

import { expect, it, onTestFinished, vi } from "vitest";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import {
  createGatewayBrowserClientFixture,
  createPaneHeaderWorkspaceFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
  getPaneTestRuntime,
} from "./chat-pane.test-support.ts";
import {
  chatPaneHeaderSessionMenu,
  mountChatPaneHeader,
  openNativeMenu,
  renderPaneHeaderInto,
} from "./components/chat-pane-header.test-support.ts";
import type { SidebarPanelDefinition } from "./components/chat-sidebar-region-types.ts";
import {
  ensureSidebarConversation,
  openSlot,
  promoteSidebarPanel,
  setSidebarExpanded,
  setSidebarOpen,
  isSidebarSlotVisible,
} from "./sidebar-layout.ts";

it("opens Discussion in the current presentation after a retained desktop header becomes mobile", async () => {
  const { pane, state } = createTestChatPane({
    client: createGatewayBrowserClientFixture(),
    sessions: createSessionCapabilityFixture(),
  });
  const runtime = getPaneTestRuntime(pane);
  pane.context.gateway.snapshot.hello = gatewayHelloForMethods([
    "session.discussion.info",
    "session.discussion.open",
  ]);
  pane.sessionDiscussion.record(state.sessionKey, "available");
  state.sidebarLayout = ensureSidebarConversation({ columns: [] });
  const workspace = createPaneHeaderWorkspaceFixture(state);
  const row = { key: state.sessionKey, kind: "direct" as const, updatedAt: 0 };
  const definitions = sidebarPanelDefinitions();
  const renderHeader = () =>
    pane.renderPaneHeader(workspace, row, false, undefined, false, null, undefined, definitions);
  const desktop = renderHeader();
  expect(
    desktop.header.panelMenuActions?.find((action) => action.id === "discussion"),
  ).toBeDefined();

  runtime.mergedChrome = true;
  runtime.mobilePresentation.open = false;
  runtime.mobilePresentation.suspended = true;
  const mobile = renderHeader();
  const discussion = mobile.header.panelMenuActions?.find((action) => action.id === "discussion");
  if (!discussion || discussion.kind === "status") {
    throw new Error("expected the Discussion action");
  }
  await discussion.onActivate();

  expect(runtime.mobilePresentation.open).toBe(true);
  expect(runtime.mobilePresentation.suspended).toBe(false);
  expect(runtime.mobilePresentation.destination).toEqual({ area: "panels", slot: "discussion" });
  expect(isSidebarSlotVisible(state.sidebarLayout, "discussion")).toBe(true);
});

it.each([
  { slot: "plugin:fixture/notes", mode: "split" },
  { slot: "dashboard", mode: "split" },
  { slot: "dashboard", mode: "expanded" },
  { slot: "dashboard", mode: "closed" },
] as const)(
  "retains $slot main when Panels toggles from $mode and reopens offline",
  ({ slot, mode }) => {
    const { pane, state } = createTestChatPane({
      client: createGatewayBrowserClientFixture(),
      sessions: createSessionCapabilityFixture(),
    });
    const definitions: SidebarPanelDefinition[] = [
      ...sidebarPanelDefinitions(),
      {
        slot: "plugin:fixture/notes",
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
    if (mode === "expanded") {
      state.sidebarLayout = setSidebarExpanded(state.sidebarLayout, true);
    } else if (mode === "closed") {
      state.sidebarLayout = setSidebarOpen(state.sidebarLayout, false);
    }
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
          undefined,
          {
            presentation: true,
            mobile: false,
            setRef: () => {},
            externalTrigger: true,
            conversationVisible: isSidebarSlotVisible(state.sidebarLayout, "conversation"),
          },
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
    expect(container.querySelectorAll(".chat-pane__chat-toggle")).toHaveLength(
      slot === "dashboard" ? 0 : 1,
    );
    expect(trigger.getAttribute("aria-expanded")).toBe(mode === "split" ? "true" : "false");
    if (mode !== "split") {
      trigger.click();
      paint();
      expect(isSidebarSlotVisible(state.sidebarLayout, "conversation")).toBe(true);
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
    }
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
    expect(isSidebarSlotVisible(state.sidebarLayout, "conversation")).toBe(true);
  },
);

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
  await openNativeMenu(menu, "submenu:advanced");
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
