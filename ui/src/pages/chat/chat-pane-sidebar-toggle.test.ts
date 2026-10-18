/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { createChatPaneRails } from "./chat-pane-rails.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
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

function dispatchPanelShortcut(
  pane: TestChatPane,
  shortcut: (typeof panelCases)[number],
  modifiers: KeyboardEventInit = {},
) {
  const event = new KeyboardEvent("keydown", {
    cancelable: true,
    key: shortcut.altKey ? shortcut.key.toUpperCase() : "ж",
    code: `Key${shortcut.key.toUpperCase()}`,
    metaKey: true,
    shiftKey: true,
    altKey: shortcut.altKey,
    ...modifiers,
  });
  pane.handleDocumentKeydown(event);
  return event;
}

function shortcutPane() {
  const result = createTestChatPane({
    client: createGatewayBrowserClientFixture(),
    sessions: createSessionCapabilityFixture(),
  });
  result.pane.active = true;
  result.state.browserPanelAvailable = true;
  return result;
}

afterEach(() => document.body.replaceChildren());

describe("chat pane sidebar toggles", () => {
  it("activates a stored Workspace tab from the rail", () => {
    const sidebarLayout = openSlot(openSlot({ columns: [] }, "workspace"), "terminal");
    const state = makeChatHost({ connected: false }) as unknown as ChatPageHost;
    const updateSidebarLayout = vi.fn((layout) => {
      state.sidebarLayout = layout;
    });

    const rails = createChatPaneRails({
      state,
      sidebarLayout,
      presentationId: "pane-left",
      presented: true,
      gatewaySnapshot: { hello: null } as never,
      setObserverVisibility: vi.fn(),
      updateSidebarLayout,
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
    const { pane, state } = shortcutPane();
    state.connected = true;
    pane.context.gateway.snapshot.phase = "connected";
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods(["desktop.observe", "board.get"]);
    // The provider has resolved Discussion availability for this session.
    pane.sessionDiscussion.record(state.sessionKey.trim(), "available");
    state.sidebarLayout = openSlot(openSlot({ columns: [] }, slot), "terminal");

    expect(isSidebarSlotVisible(state.sidebarLayout, slot)).toBe(false);
    expect(dispatchPanelShortcut(pane, shortcut).defaultPrevented).toBe(true);
    expect(state.sidebarLayout.columns[0]?.panels.map((panel) => panel.slot)).toEqual([
      slot,
      "terminal",
    ]);
    expect(isSidebarSlotVisible(state.sidebarLayout, slot)).toBe(true);
    // Ctrl is also supported; visible panels close, retaining their sibling.
    expect(
      dispatchPanelShortcut(pane, shortcut, { metaKey: false, ctrlKey: true }).defaultPrevented,
    ).toBe(true);
    expect(state.sidebarLayout.columns[0]?.panels.map((panel) => panel.slot)).toEqual(["terminal"]);

    for (const gate of ["inactive", "hidden", "consumed", "composing", "modal"] as const) {
      pane.active = gate !== "inactive";
      pane.presented = gate !== "hidden";
      const modal = document.createElement("nav");
      modal.className = "shell-nav";
      if (gate === "modal") {
        modal.setAttribute("aria-modal", "true");
        document.body.append(modal);
      }
      const event = new KeyboardEvent("keydown", {
        cancelable: true,
        key: shortcut.key,
        code: `Key${shortcut.key.toUpperCase()}`,
        metaKey: true,
        shiftKey: true,
        altKey: shortcut.altKey,
        isComposing: gate === "composing",
      });
      if (gate === "consumed") {
        event.preventDefault();
      }
      pane.handleDocumentKeydown(event);
      expect(isSidebarSlotVisible(state.sidebarLayout, slot), gate).toBe(false);
      modal.remove();
    }
    pane.active = true;
    pane.presented = true;
    // Existing panel chords work from the composer; the new chords keep that contract.
    const input = document.body.appendChild(document.createElement("textarea"));
    input.focus();
    expect(dispatchPanelShortcut(pane, shortcut).defaultPrevented).toBe(true);
    expect(isSidebarSlotVisible(state.sidebarLayout, slot)).toBe(true);
    dispatchPanelShortcut(pane, shortcut);

    if (slot === "dashboard") {
      const compactPane = pane as TestChatPane & { compact: boolean };
      compactPane.compact = true;
      expect(dispatchPanelShortcut(pane, shortcut).defaultPrevented).toBe(false);
      compactPane.compact = false;
    }
    if (slot === "discussion") {
      state.connected = false;
      expect(dispatchPanelShortcut(pane, shortcut).defaultPrevented).toBe(false);
      state.connected = true;
    }

    state.browserPanelAvailable = false;
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods([], ["operator.read"]);
    pane.sessionDiscussion.record(state.sessionKey.trim(), "none");
    if (["browser", "desktop", "discussion", "dashboard"].some((gated) => gated === slot)) {
      expect(dispatchPanelShortcut(pane, shortcut).defaultPrevented).toBe(false);
      expect(isSidebarSlotVisible(state.sidebarLayout, slot)).toBe(false);
    }
  });
});
