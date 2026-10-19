/* @vitest-environment jsdom */

import { expect, it, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import {
  createPaneHeaderWorkspaceFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
} from "./chat-pane.test-support.ts";
import {
  mountChatPaneHeader,
  renderPaneHeaderInto,
} from "./components/chat-pane-header.test-support.ts";
import type { SidebarPanelDefinition } from "./components/chat-sidebar-region-types.ts";
import { openSlot, promoteSidebarPanel, setSidebarOpen } from "./sidebar-layout.ts";

it("keeps Layout actions available across plugin panel swaps", async () => {
  const { pane, state } = createTestChatPane({
    client: { request: vi.fn() } as unknown as GatewayBrowserClient,
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
  state.sidebarLayout = promoteSidebarPanel(openSlot({ columns: [] }, slot), slot);
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
  const action = (label: string) => container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  const open = async () => {
    const menu = container.querySelector(".chat-pane__layout-menu")!;
    const panel = menu.querySelector<HTMLElement>(".oc-menu")!;
    if (!panel.matches(":popover-open")) {
      menu.querySelector<HTMLButtonElement>(".chat-pane__layout-trigger")!.click();
    }
    await waitForSolid(() => expect(panel.matches(":popover-open")).toBe(true));
    return panel;
  };
  const activate = async (label: string) => {
    const panel = await open();
    const item = action(label);
    if (!item) {
      throw new Error(`Expected Layout action: ${label}`);
    }
    item.click();
    await waitForSolid(() => expect(panel.matches(":popover-open")).toBe(false));
  };

  paint();
  await open();
  expect(container.querySelectorAll(".chat-pane__header")).toHaveLength(1);
  expect(container.querySelectorAll(".chat-side-panel-toggle")).toHaveLength(1);
  expect(action("Swap Fixture notes and Chat")).not.toBeNull();
  await activate("Focus");
  expect(state.sidebarLayout.expanded).toBe(true);
  state.connected = false;
  paint();
  expect(container.querySelector(".chat-panel-swap")).toBeNull();
  expect(action("Restore split")!.matches(":disabled")).toBe(false);
  await activate("Restore split");
  expect(state.sidebarLayout.expanded).toBe(false);
  paint();
  expect(action("Swap Fixture notes and Chat")!.matches(":disabled")).toBe(false);
  await activate("Swap Fixture notes and Chat");
  paint();
  expect(action("Swap Chat and Fixture notes")).not.toBeNull();

  state.sidebarLayout = setSidebarOpen({ columns: [] }, true);
  paint();
  expect(container.querySelector(".chat-panel-swap")).toBeNull();
  expect(container.querySelectorAll(".chat-side-panel-toggle")).toHaveLength(1);
  await activate("Minimize side panel");
  expect(state.sidebarLayout.open).toBe(false);
});

it("retains focused Layout controls and an open menu when header props refresh", async () => {
  const focusAtSplit: (Element | null)[] = [];
  const onSplitRight = vi.fn<(paneId: string) => void>(() => {
    focusAtSplit.push(document.activeElement);
  });
  const sidebarLayout = () => openSlot({ columns: [] }, "workspace");
  const mounted = mountChatPaneHeader([], {
    onClosePane: vi.fn(),
    onSplitRight,
    sidebarLayout: sidebarLayout(),
    panelDefinitions: sidebarPanelDefinitions(),
    onLayoutChange: vi.fn(),
  });
  onTestFinished(() => {
    mounted.unmount();
    mounted.container.remove();
  });
  const trigger = mounted.container.querySelector<HTMLButtonElement>(".chat-pane__layout-trigger")!;
  const menu = mounted.container.querySelector<HTMLElement>(".chat-pane__layout-menu")!;
  const panel = menu.querySelector<HTMLElement>(".oc-menu")!;
  flush();
  trigger.click();
  await waitForSolid(() => expect(panel.matches(":popover-open")).toBe(true));
  const close = mounted.container.querySelector(".chat-pane__close-pane")!;
  const split = mounted.container.querySelector<HTMLButtonElement>(".chat-pane__split-right")!;
  trigger.focus();
  mounted.update({
    title: "Updated session title",
    sidebarLayout: sidebarLayout(),
    panelDefinitions: sidebarPanelDefinitions(),
  });
  expect(mounted.container.querySelector(".chat-pane__layout-trigger")).toBe(trigger);
  expect(mounted.container.querySelector(".chat-pane__close-pane")).toBe(close);
  expect(mounted.container.querySelector(".chat-pane__split-right")).toBe(split);
  expect(document.activeElement).toBe(trigger);
  expect(mounted.container.querySelector(".chat-pane__layout-menu")).toBe(menu);
  expect(panel.matches(":popover-open")).toBe(true);
  split.focus();
  split.click();
  await waitForSolid(() => expect(panel.matches(":popover-open")).toBe(false));
  expect(document.activeElement).toBe(trigger);
  expect(focusAtSplit).toEqual([trigger]);
  expect(onSplitRight).toHaveBeenCalledExactlyOnceWith("pane-1");
});

it("keeps a native external panel link when it is the only Layout action", async () => {
  // jsdom has no layout; this fixture's only native control is visible.
  Object.defineProperty(HTMLElement.prototype, "checkVisibility", {
    configurable: true,
    value: () => true,
  });
  onTestFinished(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "checkVisibility");
  });
  const panelDefinitions = sidebarPanelDefinitions();
  panelDefinitions.find((definition) => definition.slot === "conversation")!.headerLink = {
    href: "https://example.test/panel",
    label: "Open panel",
  };
  const mounted = mountChatPaneHeader([], { sidebarLayout: { columns: [] }, panelDefinitions });
  onTestFinished(mounted.unmount);
  const trigger = mounted.container.querySelector<HTMLButtonElement>(".chat-pane__layout-trigger")!;
  trigger.click();
  await waitForSolid(() =>
    expect(mounted.container.querySelector('a[aria-label="Open panel"]')).not.toBeNull(),
  );
  const link = mounted.container.querySelector<HTMLAnchorElement>('a[aria-label="Open panel"]')!;
  expect(link.href).toBe("https://example.test/panel");
  expect(link.target).toBe("_blank");
  expect(link.rel).toBe("noopener");
  expect(link.closest(".oc-menu")?.matches(":popover-open")).toBe(true);
});
