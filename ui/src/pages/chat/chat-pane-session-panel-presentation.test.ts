/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPanelToggleSlot } from "../../components/session-panel-toggle-buffer.ts";
import { terminalIntentQueue } from "../../components/terminal/terminal-pending-actions.ts";
import {
  ChatPaneSessionPanelToggleController,
  type PendingSessionPanelToggle,
} from "./chat-pane-session-panel-toggle.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  closeSlot,
  ensureSidebarConversation,
  isSidebarSlotVisible,
  openSlot,
  promoteSidebarPanel,
  setSidebarDock,
  type SidebarLayout,
} from "./sidebar-layout.ts";

const panelTags = {
  browser: "openclaw-browser-panel",
  desktop: "openclaw-desktop-panel",
  portal: "openclaw-portals-page",
  terminal: "openclaw-terminal-panel",
} as const;

function createController(layout: SidebarLayout) {
  const state = { sessionKey: "agent:main:movie", sidebarLayout: layout } as ChatPageHost;
  const pending = new Map<SessionPanelToggleSlot, PendingSessionPanelToggle>();
  const owner = {
    state,
    linkReaders: [],
    pluginPanels: [],
    renderRoot: document.createDocumentFragment(),
    updateComplete: Promise.resolve(),
  };
  const controller = new ChatPaneSessionPanelToggleController({
    current: () => owner,
    pending,
    requestUpdate: vi.fn(),
    updateSidebarLayout: (next) => {
      state.sidebarLayout = next;
    },
  });
  const show = async (slot: keyof typeof panelTags, expanded: boolean) => {
    controller.handle(
      slot,
      panelTags[slot],
      new CustomEvent(`openclaw:${slot}-toggle`, {
        detail: { sessionKey: state.sessionKey, open: true, expanded },
      }),
    );
    await vi.waitFor(() => expect(pending.size).toBe(0));
  };
  return { state, show };
}

describe("session panel presentation commands", () => {
  beforeEach(() => {
    // Layout commands do not depend on a surface's lazy import or terminal connection.
    vi.spyOn(customElements, "whenDefined").mockResolvedValue(class extends HTMLElement {});
    vi.spyOn(terminalIntentQueue, "queue").mockResolvedValue();
  });

  afterEach(() => vi.restoreAllMocks());

  it.each(["browser", "desktop", "portal", "terminal"] as const)(
    "expands %s in place and restores the saved split without replacing its tabs",
    async (slot) => {
      const layout = setSidebarDock(
        openSlot(openSlot(ensureSidebarConversation({ columns: [] }), "workspace"), slot),
        "bottom",
      );
      const { state, show } = createController(layout);

      await show(slot, true);
      expect(isSidebarSlotVisible(state.sidebarLayout, slot)).toBe(true);
      expect(isSidebarSlotVisible(state.sidebarLayout, "conversation")).toBe(false);
      expect(state.sidebarLayout.mainPanelId).toBe(layout.mainPanelId);

      await show(slot, true);
      expect(isSidebarSlotVisible(state.sidebarLayout, "conversation")).toBe(false);

      await show(slot, false);
      expect(isSidebarSlotVisible(state.sidebarLayout, slot)).toBe(true);
      expect(isSidebarSlotVisible(state.sidebarLayout, "conversation")).toBe(true);
      expect(state.sidebarLayout).toEqual({ ...layout, expanded: false });
    },
  );

  it("expands and restores a portal already promoted to the main view", async () => {
    const layout = promoteSidebarPanel(
      openSlot(ensureSidebarConversation({ columns: [] }), "portal"),
      "portal",
    );
    const { state, show } = createController(layout);

    await show("portal", true);
    expect(isSidebarSlotVisible(state.sidebarLayout, "portal")).toBe(true);
    expect(isSidebarSlotVisible(state.sidebarLayout, "conversation")).toBe(false);

    await show("portal", false);
    expect(state.sidebarLayout).toEqual(layout);
    expect(isSidebarSlotVisible(state.sidebarLayout, "conversation")).toBe(true);

    state.sidebarLayout = closeSlot(state.sidebarLayout, "conversation");
    expect(isSidebarSlotVisible(state.sidebarLayout, "conversation")).toBe(false);
    await show("portal", false);
    expect(state.sidebarLayout).toEqual(layout);
    expect(isSidebarSlotVisible(state.sidebarLayout, "conversation")).toBe(true);
  });
});
