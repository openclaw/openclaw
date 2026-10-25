import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ControlUiLinkReaderDescriptor } from "../../../../src/shared/control-ui-link-reader.js";
import "./components/chat-sidebar-region.runtime.tsx";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  BROWSER_PANEL_TOGGLE_EVENT,
  LINK_READER_PANEL_TOGGLE_EVENT,
  PLUGIN_PANEL_TOGGLE_EVENT,
  TERMINAL_PANEL_TOGGLE_EVENT,
  TERMINAL_PANEL_DOCK_BOTTOM_EVENT,
} from "../../components/panel-toggle-contract.ts";
import {
  rememberSessionPanelToggle,
  type SessionPanelToggleSlot,
} from "../../components/session-panel-toggle-buffer.ts";
import {
  createChatPaneSessionPanelToggles,
  type PendingSessionPanelToggle,
} from "./chat-pane-session-panel-toggle.ts";
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
} from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createPageState } from "./chat-state-page.ts";
import {
  ensureSidebarConversation,
  isSidebarSlotVisible,
  openSlot,
  setSidebarDock,
} from "./sidebar-layout.ts";

const reader: ControlUiLinkReaderDescriptor = {
  pluginId: "forge",
  id: "items",
  label: "Forge",
  linkReader: {
    hosts: ["forge.example"],
    pathPattern: "^/items/[0-9]+$",
    detailMethod: "forge.item",
  },
};

const toggle = (eventName: string, detail: unknown) =>
  window.dispatchEvent(new CustomEvent(eventName, { detail }));

function trackToggles(options: Parameters<typeof createChatPaneSessionPanelToggles>[0]) {
  let flush!: () => void;
  onTestFinished(
    createRoot((dispose) => {
      flush = createChatPaneSessionPanelToggles(options);
      return dispose;
    }),
  );
  return flush;
}

function fixture() {
  const definitions = createDeferred<CustomElementConstructor>();
  const commit = createDeferred<boolean>();
  const region = document.createElement("openclaw-chat-sidebar-region");
  const deliverPanelEvent = vi.fn();
  Object.defineProperty(region, "updateComplete", { value: commit.promise });
  region.deliverPanelEvent = deliverPanelEvent;
  const root = document.createElement("div");
  root.append(region);
  const recipient = root.appendChild(document.createElement("div"));
  let recipientMounted = false;
  region.readPanelHost = () => (recipientMounted ? recipient : null);
  const state = createPageState(
    createInitializationContext(),
    { afterCommit: () => () => {} },
    root,
  );
  state.connected = true;
  state.client = createGatewayBrowserClientFixture();
  state.sessionKey = "session-a";
  state.sidebarLayout = { columns: [] };
  const owner = {
    sidebarRegion: region,
    state,
    linkReaders: [reader],
    pluginPanels: ["review/document"] as const,
    awaitDomCommit: () => Promise.resolve(),
  };
  const pending = { requests: new Map<SessionPanelToggleSlot, PendingSessionPanelToggle>() };
  const updateSidebarLayout = vi.fn((layout: ChatPageHost["sidebarLayout"]) => {
    state.sidebarLayout = layout;
  });
  const flush = trackToggles({
    current: () => owner,
    pending,
    updateSidebarLayout,
  });
  // The region reports a committed lazy recipient through its readiness callback.
  void definitions.promise.then(() => {
    recipientMounted = true;
    flush();
  });

  const event = (url = "https://forge.example/items/1") =>
    new CustomEvent(LINK_READER_PANEL_TOGGLE_EVENT, {
      cancelable: true,
      detail: { url, open: true },
    });
  return {
    close: () => toggle(LINK_READER_PANEL_TOGGLE_EVENT, { open: false }),
    ready: () => {
      definitions.resolve(HTMLElement);
      commit.resolve(true);
    },
    flush,
    definitions,
    commit,
    deliverPanelEvent,
    event,
    owner,
    region,
    root,
    pending,
    state,
    updateSidebarLayout,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("opens the terminal while the sidebar region bridge awaits upgrade", () => {
  const f = fixture();
  // The pane creates the host before the lazy sidebar renderer registers its bridge.
  Object.defineProperty(f.region, "activateTerminalHost", { value: undefined });
  window.dispatchEvent(new Event(TERMINAL_PANEL_TOGGLE_EVENT));
  expect(isSidebarSlotVisible(f.state.sidebarLayout, "terminal")).toBe(true);
});

it.each([
  ["desktop", true],
  ["mobile", false],
] as const)(
  "preserves the %s panel state when moving its last terminal to the bottom",
  (presentation, open) => {
    const f = fixture();
    f.region.presentation = presentation;
    f.state.sidebarLayout = openSlot(f.state.sidebarLayout, "terminal");
    window.dispatchEvent(new Event(TERMINAL_PANEL_DOCK_BOTTOM_EVENT));
    expect(isSidebarSlotVisible(f.state.sidebarLayout, "terminal")).toBe(false);
    expect(f.state.sidebarLayout.open).toBe(open);
  },
);

it("expands in place and restores the selected panel and dock", () => {
  const slot = "browser";
  const f = fixture();
  const layout = setSidebarDock(
    openSlot(openSlot(ensureSidebarConversation({ columns: [] }), "workspace"), slot),
    "bottom",
  );
  f.state.sidebarLayout = layout;
  const show = (expanded: boolean) =>
    toggle(BROWSER_PANEL_TOGGLE_EVENT, { sessionKey: f.state.sessionKey, open: true, expanded });
  show(true);
  expect(isSidebarSlotVisible(f.state.sidebarLayout, slot)).toBe(true);
  expect(isSidebarSlotVisible(f.state.sidebarLayout, "conversation")).toBe(false);
  expect(f.state.sidebarLayout.mainPanelId).toBe(layout.mainPanelId);
  show(true);
  expect(isSidebarSlotVisible(f.state.sidebarLayout, "conversation")).toBe(false);
  show(false);
  expect(f.state.sidebarLayout).toEqual({ ...layout, expanded: false });
});

describe("plugin panel intent delivery", () => {
  it.each(["buffered", "direct"] as const)(
    "routes %s intents only to registered session panels",
    (delivery) => {
      const f = fixture();
      const send = (panelId: string, open: boolean) =>
        new CustomEvent(PLUGIN_PANEL_TOGGLE_EVENT, {
          detail: { pluginId: "review", panelId, sessionKey: "session-b", open },
        });
      const event = send("document", true);
      if (delivery === "buffered") {
        rememberSessionPanelToggle("plugin:review/document", event);
        f.flush();
      } else {
        window.dispatchEvent(event);
      }
      expect(f.updateSidebarLayout).not.toHaveBeenCalled();
      f.state.sessionKey = "session-b";
      window.dispatchEvent(send("missing", true));
      expect(f.updateSidebarLayout).not.toHaveBeenCalled();
      if (delivery === "buffered") {
        f.flush();
      } else {
        window.dispatchEvent(event);
      }
      expect(isSidebarSlotVisible(f.state.sidebarLayout, "plugin:review/document")).toBe(true);
      window.dispatchEvent(send("document", false));
      expect(isSidebarSlotVisible(f.state.sidebarLayout, "plugin:review/document")).toBe(false);
    },
  );
});

describe("session link-reader intent delivery", () => {
  it.each([
    ["pane", "ready"],
    ["pane", "closed"],
    ["pane", "session"],
    ["recipient", "ready"],
    ["recipient", "closed"],
    ["recipient", "session"],
  ] as const)(
    "waits for the %s commit before delivering an intent (%s)",
    async (boundary, outcome) => {
      vi.useFakeTimers();
      const f = fixture();
      const heldCommit = createDeferred();
      f.owner.awaitDomCommit = () => (boundary === "pane" ? heldCommit.promise : Promise.resolve());
      const recipient = document.createElement("openclaw-link-reader-panel");
      Object.defineProperty(recipient, "updateComplete", {
        value: boundary === "recipient" ? heldCommit.promise : Promise.resolve(),
      });
      f.root.append(recipient);
      f.region.readPanelHost = () => recipient;
      const event = f.event();
      window.dispatchEvent(event);
      f.ready();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.deliverPanelEvent).not.toHaveBeenCalled();
      if (outcome === "closed") {
        f.close();
      } else if (outcome === "session") {
        f.state.sessionKey = "session-b";
      }
      heldCommit.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.pending.requests.size).toBe(0);
      if (outcome === "ready") {
        expect(f.deliverPanelEvent).toHaveBeenCalledExactlyOnceWith("link-reader", event);
      } else {
        expect(f.deliverPanelEvent).not.toHaveBeenCalled();
      }
    },
  );

  it("delivers every buffered reader intent in order after the lazy commit", async () => {
    const f = fixture();
    const first = f.event();
    const second = f.event("https://forge.example/items/2");
    rememberSessionPanelToggle("link-reader", first);
    rememberSessionPanelToggle("link-reader", second);
    f.flush();
    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(true);
    expect(f.state.sidebarLayout.columns[0]?.panels).toEqual([
      { id: "link-reader", slot: "link-reader" },
    ]);
    expect(f.deliverPanelEvent).not.toHaveBeenCalled();
    f.definitions.resolve(HTMLElement);
    await Promise.resolve();
    expect(f.deliverPanelEvent).not.toHaveBeenCalled();
    f.commit.resolve(true);
    await vi.waitFor(() => expect(f.deliverPanelEvent).toHaveBeenCalledTimes(2));
    expect(f.deliverPanelEvent.mock.calls).toEqual([
      ["link-reader", first],
      ["link-reader", second],
    ]);
    expect(f.pending.requests.size).toBe(0);
  });

  it("does not append a new session intent to a retired pending batch", async () => {
    const f = fixture();
    const old = f.event();
    window.dispatchEvent(old);
    f.state.sessionKey = "session-b";
    const current = f.event("https://forge.example/items/2");
    window.dispatchEvent(current);
    f.ready();
    await vi.waitFor(() => expect(f.deliverPanelEvent).toHaveBeenCalledTimes(1));
    expect(f.deliverPanelEvent).toHaveBeenCalledWith("link-reader", current);
    expect(f.pending.requests.size).toBe(0);
  });

  it.each([
    { change: "close", ready: false },
    { change: "close", ready: true },
    { change: "session", ready: true },
    { change: "capability", ready: true },
  ])(
    "retires a pending batch after $change (definitions ready=$ready)",
    async ({ change, ready }) => {
      const f = fixture();
      window.dispatchEvent(f.event());
      window.dispatchEvent(f.event("https://forge.example/items/2"));
      if (ready) {
        f.definitions.resolve(HTMLElement);
        await Promise.resolve();
        await Promise.resolve();
      }
      if (change === "close") {
        f.close();
        expect(f.pending.requests.size).toBe(0);
      } else if (change === "session") {
        f.state.sessionKey = "session-b";
      } else {
        f.owner.linkReaders = [];
      }
      f.ready();
      await f.commit.promise;
      await Promise.resolve();
      await Promise.resolve();
      expect(f.deliverPanelEvent).not.toHaveBeenCalled();
    },
  );

  it("keeps unsupported URLs unaccepted and leaves the layout alone", () => {
    const f = fixture();
    const event = f.event("https://example.com/ordinary-link");
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(f.updateSidebarLayout).not.toHaveBeenCalled();
  });

  it("retires an unmounted recipient's pending intent when its panel closes", async () => {
    const f = fixture();
    window.dispatchEvent(f.event());
    f.state.sidebarLayout = { columns: [] };
    f.flush();
    expect(f.pending.requests.size).toBe(0);
    f.ready();
    await f.definitions.promise;
    expect(f.deliverPanelEvent).not.toHaveBeenCalled();
  });
});
