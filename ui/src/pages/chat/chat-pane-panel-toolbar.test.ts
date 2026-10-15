/* @vitest-environment jsdom */

import { html, render } from "lit";
import { flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { settleWebAwesome } from "../../test-helpers/web-awesome.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import {
  createPaneHeaderWorkspaceFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
} from "./chat-pane.test-support.ts";
import { mountChatPaneHeader } from "./components/chat-pane-header.test-support.ts";
import type { SidebarPanelDefinition } from "./components/chat-sidebar-region-types.ts";
import { openSlot, promoteSidebarPanel, setSidebarOpen } from "./sidebar-layout.ts";

it("keeps content actions and focus in Layout across plugin panel swaps", () => {
  const { pane, state } = createTestChatPane({
    client: { request: vi.fn() } as unknown as GatewayBrowserClient,
    sessions: createSessionCapabilityFixture(),
  });
  const slot = "plugin:fixture/notes";
  const refresh = vi.fn();
  const definitions: SidebarPanelDefinition[] = [
    ...sidebarPanelDefinitions(),
    {
      slot,
      label: "Fixture notes",
      icon: html``,
      available: true,
      content: html`Notes`,
      loading: html`Loading notes`,
      empty: { description: "No notes" },
      headerAction: html`<button aria-label="Refresh notes" @click=${refresh}>
        Refresh notes
      </button>`,
    },
  ];
  state.sidebarLayout = promoteSidebarPanel(openSlot({ columns: [] }, slot), slot);
  const container = document.createElement("div");
  const paint = () =>
    render(
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
  const action = (label: string) => container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  const activate = (label: string) => {
    const item = action(label)!;
    const menu = container.querySelector(".chat-pane__layout-menu")!;
    menu.dispatchEvent(
      new CustomEvent("wa-select", { detail: { item: { value: item.getAttribute("value") } } }),
    );
    menu.dispatchEvent(new CustomEvent("wa-after-hide"));
  };

  paint();
  container.querySelector(".chat-pane__layout-menu")!.dispatchEvent(new Event("wa-show"));
  flush();
  expect(container.querySelectorAll(".chat-pane__header")).toHaveLength(1);
  expect(container.querySelectorAll(".chat-side-panel-toggle")).toHaveLength(1);
  expect(action("Swap Fixture notes and Chat")).not.toBeNull();
  action("Refresh notes")!.click();
  expect(refresh).toHaveBeenCalledOnce();
  activate("Focus");
  expect(state.sidebarLayout.expanded).toBe(true);
  state.connected = false;
  paint();
  expect(container.querySelector(".chat-panel-swap")).toBeNull();
  expect(action("Refresh notes")).not.toBeNull();
  expect(action("Restore split")!.matches(":disabled")).toBe(false);
  activate("Restore split");
  expect(state.sidebarLayout.expanded).toBe(false);
  paint();
  expect(action("Swap Fixture notes and Chat")!.matches(":disabled")).toBe(false);
  activate("Swap Fixture notes and Chat");
  paint();
  expect(action("Swap Chat and Fixture notes")).not.toBeNull();
  expect(action("Refresh notes")).not.toBeNull();

  state.sidebarLayout = setSidebarOpen({ columns: [] }, true);
  paint();
  expect(container.querySelector(".chat-panel-swap")).toBeNull();
  expect(container.querySelectorAll(".chat-side-panel-toggle")).toHaveLength(1);
  activate("Minimize side panel");
  expect(state.sidebarLayout.open).toBe(false);
});

it("retains focused Layout controls and an open menu when header props refresh", async () => {
  const onSplitRight = vi.fn();
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
  const menu = mounted.container.querySelector<HTMLElement & { open: boolean }>(
    ".chat-pane__layout-menu",
  )!;
  menu.open = true;
  menu.dispatchEvent(new Event("wa-show"));
  flush();
  await settleWebAwesome(mounted.container);
  const close = mounted.container.querySelector(".chat-pane__close-pane")!;
  const split = mounted.container.querySelector(".chat-pane__split-right")!;
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
  expect(menu.open).toBe(true);
  menu.dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value: "split-right" } } }));
  menu.dispatchEvent(new Event("wa-after-hide"));
  expect(onSplitRight).toHaveBeenCalledExactlyOnceWith("pane-1");
});
