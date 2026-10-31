/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { sidebarPanelFixtureParams } from "../../test-helpers/chat-pane-embedded-panels.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createGatewayBrowserClientFixture } from "./chat-application-context.test-support.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import { createChatPaneRails } from "./chat-pane-rails.ts";
import {
  createPaneHeaderWorkspaceFixture,
  createTestChatPane,
  getPaneTestRuntime,
} from "./chat-pane.test-support.ts";
import { createSessionCapabilityFixture } from "./chat-session-capability.test-support.ts";
import {
  ensureSidebarConversation,
  isSidebarSlotVisible,
  openSlot,
  promoteSidebarPanel,
  sidebarMainPanel,
} from "./sidebar-layout.ts";

const panelCases = [
  { key: "b", slot: "workspace", altKey: false },
  { key: "s", slot: "companion", altKey: false },
  { key: "u", slot: "browser", altKey: true },
  { key: "d", slot: "desktop", altKey: true },
  { key: "j", slot: "discussion", altKey: true },
  { key: "g", slot: "dashboard", altKey: true },
  { key: "e", slot: "detail", altKey: true },
] as const;

function panelShortcut(shortcut: (typeof panelCases)[number], modifiers: KeyboardEventInit = {}) {
  return new KeyboardEvent("keydown", {
    bubbles: true,
    composed: true,
    cancelable: true,
    key: shortcut.altKey ? "¨" : "ж",
    code: `Key${shortcut.key.toUpperCase()}`,
    metaKey: true,
    shiftKey: true,
    altKey: shortcut.altKey,
    ...modifiers,
  });
}

function shortcutPane() {
  const result = createTestChatPane({
    client: createGatewayBrowserClientFixture(),
    sessions: createSessionCapabilityFixture(),
  });
  result.pane.active = true;
  result.state.browserPanelAvailable = true;
  result.state.hello!.features!.methods!.push("sessions.companion.state");
  result.pane.context.gateway.snapshot.hello = result.state.hello;
  return {
    ...result,
    visible: (slot: Parameters<typeof isSidebarSlotVisible>[1]) =>
      isSidebarSlotVisible(result.state.sidebarLayout, slot),
    slots: () => result.state.sidebarLayout.columns[0]?.panels.map((panel) => panel.slot),
    dispatch: (
      shortcut: (typeof panelCases)[number],
      modifiers?: KeyboardEventInit,
      target?: HTMLElement,
    ) => {
      const event = panelShortcut(shortcut, modifiers);
      if (target) {
        target.dispatchEvent(event);
      } else {
        result.pane.handleDocumentKeydown(event);
      }
      return event.defaultPrevented;
    },
  };
}

afterEach(() => document.body.replaceChildren());

describe("chat pane sidebar toggles", () => {
  it("keeps native mobile restoration chat-first without changing saved layouts or explicit dashboard routes", () => {
    Object.assign(window, { __OPENCLAW_NATIVE_EMBED__: { platform: "ios", formFactor: "pad" } });
    onTestFinished(() => {
      Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_EMBED__");
    });
    const { pane } = shortcutPane();
    pane.routeFace = "chat";
    const layout = ensureSidebarConversation(openSlot({ columns: [] }, "dashboard"));
    const dashboard = layout.columns[0]!.panels.find((panel) => panel.slot === "dashboard")!;
    const saved = { ...promoteSidebarPanel(layout, dashboard.id), open: true, expanded: true };
    const restored = pane.restorePaneSidebarLayout(saved);
    expect(restored).toMatchObject({ open: false, expanded: false });
    expect(sidebarMainPanel(restored)?.slot).toBe("conversation");
    expect(saved.expanded).toBe(true);
    pane.routeFace = "dashboard";
    expect(pane.restorePaneSidebarLayout(saved)).toBe(saved);
  });

  it("does not open Side Chat with session-only permission", () => {
    const { pane, state, dispatch, visible } = shortcutPane();
    const menuActions = () =>
      pane
        .renderPaneHeader(
          createPaneHeaderWorkspaceFixture(state),
          undefined,
          false,
          undefined,
          false,
          null,
          state.sidebarLayout,
          sidebarPanelDefinitions(sidebarPanelFixtureParams(state)),
        )
        .header.panelMenuActions?.map((action) => action.id);
    expect(menuActions()).toContain("session-companion");
    state.hello!.auth!.scopes = ["operator.sessions.write"];
    expect(dispatch(panelCases[1])).toBe(false);
    expect(visible("companion")).toBe(false);
    expect(menuActions()).not.toContain("session-companion");
  });
  it("activates a stored Workspace tab from the rail", () => {
    const sidebarLayout = openSlot(openSlot({ columns: [] }, "workspace"), "terminal");
    const { state } = shortcutPane();
    state.connected = false;

    const rails = createChatPaneRails({
      state,
      sidebarLayout,
      presentationId: "pane-left",
      presented: true,
      gatewaySnapshot: { hello: null } as never,
      setObserverVisibility: vi.fn(),
      updateSidebarLayout: (layout) => {
        state.sidebarLayout = layout;
      },
    });

    expect(rails.sessionWorkspace.collapsed).toBe(true);
    rails.sessionWorkspace.onToggleCollapsed();

    expect(state.sidebarLayout.columns[0]?.panels.map((panel) => panel.slot)).toEqual([
      "workspace",
      "terminal",
    ]);
    expect(isSidebarSlotVisible(state.sidebarLayout, "workspace")).toBe(true);
  });

  it.each(panelCases)("toggles the available $slot in the active pane", (shortcut) => {
    const { slot } = shortcut;
    const { pane, state, dispatch, visible, slots } = shortcutPane();
    state.connected = true;
    pane.context.gateway.snapshot.phase = "connected";
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods([
      "desktop.observe",
      "board.get",
      "sessions.companion.state",
    ]);
    // The provider has resolved Discussion availability for this session.
    pane.sessionDiscussion.record(state.sessionKey.trim(), "available");
    state.sidebarLayout = openSlot(openSlot({ columns: [] }, slot), "terminal");
    const input = document.body.appendChild(document.createElement("textarea"));
    input.addEventListener("keydown", pane.handleDocumentKeydown);
    input.focus();
    const press = (modifiers?: KeyboardEventInit) => dispatch(shortcut, modifiers, input);
    if (slot === "detail") {
      expect(press({ key: "Ę", metaKey: false, ctrlKey: true })).toBe(false);
    }

    expect(visible(slot)).toBe(false);
    expect(press()).toBe(true);
    expect(slots()).toEqual([slot, "terminal"]);
    expect(visible(slot)).toBe(true);
    // Ctrl is also supported; visible panels close, retaining their sibling.
    expect(press({ key: shortcut.key.toUpperCase(), metaKey: false, ctrlKey: true })).toBe(true);
    expect(slots()).toEqual(["terminal"]);

    if (slot === "dashboard") {
      getPaneTestRuntime(pane).compact = true;
      expect(press()).toBe(false);
      getPaneTestRuntime(pane).compact = false;
    }
    if (slot === "discussion") {
      state.connected = false;
      expect(press()).toBe(false);
      state.connected = true;
    }

    state.browserPanelAvailable = false;
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods([], ["operator.read"]);
    pane.sessionDiscussion.record(state.sessionKey.trim(), "none");
    if (["browser", "desktop", "discussion", "dashboard"].some((gated) => gated === slot)) {
      expect(press()).toBe(false);
      expect(visible(slot)).toBe(false);
    }
  });
});
