/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { sidebarPanelFixtureParams } from "../../test-helpers/chat-pane-embedded-panels.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import { createChatPaneRails } from "./chat-pane-rails.ts";
import {
  createGatewayBrowserClientFixture,
  createPaneHeaderWorkspaceFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import { isSidebarSlotVisible, openSlot } from "./sidebar-layout.ts";

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
    cancelable: true,
    key: shortcut.altKey ? shortcut.key.toUpperCase() : "ж",
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
    dispatch: (shortcut: (typeof panelCases)[number], modifiers?: KeyboardEventInit) => {
      const event = panelShortcut(shortcut, modifiers);
      result.pane.handleDocumentKeydown(event);
      return event.defaultPrevented;
    },
  };
}

afterEach(() => document.body.replaceChildren());

describe("chat pane sidebar toggles", () => {
  it("does not open Side Chat with session-only permission", () => {
    const { pane, state, dispatch } = shortcutPane();
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
    expect(isSidebarSlotVisible(state.sidebarLayout, "companion")).toBe(false);
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

  it.each([
    ["macOS Option symbol in the composer", "¨", "KeyU", "browser", true, false, true, true],
    ["AltGr text in the composer", "Ę", "KeyE", "detail", false, true, true, false],
    ["US Ctrl+Alt review chord in the composer", "E", "KeyE", "detail", false, true, true, true],
    ["plain workspace chord in the composer", "B", "KeyB", "workspace", true, false, false, true],
  ] as const)(
    "handles %s without consuming ordinary text",
    (_name, key, code, slot, metaKey, ctrlKey, altKey, accepted) => {
      const { pane, state } = shortcutPane();
      state.sidebarLayout = { columns: [] };
      const target = document.body.appendChild(document.createElement("textarea"));
      target.addEventListener("keydown", pane.handleDocumentKeydown);
      target.focus();
      const event = new KeyboardEvent("keydown", {
        key,
        code,
        metaKey,
        ctrlKey,
        altKey,
        shiftKey: true,
        bubbles: true,
        composed: true,
        cancelable: true,
      });

      target.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(accepted);
      expect(isSidebarSlotVisible(state.sidebarLayout, slot)).toBe(accepted);
    },
  );

  it.each(panelCases)("toggles the available $slot in the active pane", (shortcut) => {
    const { slot } = shortcut;
    const { pane, state, dispatch } = shortcutPane();
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

    expect(isSidebarSlotVisible(state.sidebarLayout, slot)).toBe(false);
    expect(dispatch(shortcut)).toBe(true);
    expect(state.sidebarLayout.columns[0]?.panels.map((panel) => panel.slot)).toEqual([
      slot,
      "terminal",
    ]);
    expect(isSidebarSlotVisible(state.sidebarLayout, slot)).toBe(true);
    // Ctrl is also supported; visible panels close, retaining their sibling.
    expect(dispatch(shortcut, { metaKey: false, ctrlKey: true })).toBe(true);
    expect(state.sidebarLayout.columns[0]?.panels.map((panel) => panel.slot)).toEqual(["terminal"]);

    // Existing panel chords work from the composer; the new chords keep that contract.
    const input = document.body.appendChild(document.createElement("textarea"));
    input.focus();
    expect(dispatch(shortcut)).toBe(true);
    expect(isSidebarSlotVisible(state.sidebarLayout, slot)).toBe(true);
    dispatch(shortcut);

    if (slot === "dashboard") {
      const compactPane = pane as TestChatPane & { compact: boolean };
      compactPane.compact = true;
      expect(dispatch(shortcut)).toBe(false);
      compactPane.compact = false;
    }
    if (slot === "discussion") {
      state.connected = false;
      expect(dispatch(shortcut)).toBe(false);
      state.connected = true;
    }

    state.browserPanelAvailable = false;
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods([], ["operator.read"]);
    pane.sessionDiscussion.record(state.sessionKey.trim(), "none");
    if (["browser", "desktop", "discussion", "dashboard"].some((gated) => gated === slot)) {
      expect(dispatch(shortcut)).toBe(false);
      expect(isSidebarSlotVisible(state.sidebarLayout, slot)).toBe(false);
    }
  });
});
