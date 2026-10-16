import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import "./components/chat-sidebar-region.runtime.tsx";
import "../../components/browser/browser-panel.ts";
import type { ControlUiLinkReaderDescriptor } from "../../../../src/shared/control-ui-link-reader.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  createBrowserClient,
  stubScreenshotMedia,
  createBrowserPanelTestMetrics,
} from "../../components/browser/browser-panel-controller-test-support.ts";
import {
  LINK_READER_PANEL_TOGGLE_EVENT,
  PLUGIN_PANEL_TOGGLE_EVENT,
} from "../../components/panel-toggle-contract.ts";
import {
  rememberSessionPanelToggle,
  type SessionPanelToggleSlot,
} from "../../components/session-panel-toggle-buffer.ts";
import { solidContent } from "../../lit/solid-content.tsx";
import { renderPaneLegacyContent } from "../../test-helpers/chat-pane-embedded-panels.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import {
  createChatPaneSessionPanelToggles,
  type PendingSessionPanelToggle,
} from "./chat-pane-session-panel-toggle.ts";
import { renderSidebarRegion } from "./chat-pane-sidebar-layout.ts";
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
} from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createPageState } from "./chat-state-page.ts";
import { isSidebarSlotVisible } from "./sidebar-layout.ts";

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

function fixture() {
  const definitions = createDeferred<CustomElementConstructor>();
  const commit = createDeferred<boolean>();
  vi.spyOn(customElements, "whenDefined").mockReturnValue(definitions.promise);
  const region = document.createElement("openclaw-chat-sidebar-region");
  const deliverPanelEvent = vi.fn();
  Object.defineProperty(region, "updateComplete", { value: commit.promise });
  region.deliverPanelEvent = deliverPanelEvent;
  const root = document.createElement("div");
  root.append(region);
  const state = createPageState(
    createInitializationContext(),
    { invalidate: vi.fn(), afterCommit: () => () => {} },
    root,
  );
  state.connected = true;
  state.client = createGatewayBrowserClientFixture();
  state.sessionKey = "session-a";
  state.sidebarLayout = { columns: [] };
  const owner = {
    renderRoot: root,
    state,
    linkReaders: [reader],
    pluginPanels: ["review/document"] as const,
    updateComplete: Promise.resolve(),
  };
  const pending = new Map<SessionPanelToggleSlot, PendingSessionPanelToggle>();
  const requestUpdate = vi.fn();
  const updateSidebarLayout = vi.fn((layout: ChatPageHost["sidebarLayout"]) => {
    state.sidebarLayout = layout;
  });
  let flush!: () => void;
  const dispose = createRoot((stop) => {
    flush = createChatPaneSessionPanelToggles({
      current: () => owner,
      pending,
      requestUpdate,
      updateSidebarLayout,
    });
    return stop;
  });
  onTestFinished(dispose);

  const event = (url = "https://forge.example/items/1") =>
    new CustomEvent(LINK_READER_PANEL_TOGGLE_EVENT, {
      cancelable: true,
      detail: { url, open: true },
    });
  return {
    flush,
    dispose,
    definitions,
    commit,
    deliverPanelEvent,
    event,
    owner,
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

describe("plugin panel intent delivery", () => {
  it.each(["buffered", "direct"] as const)(
    "routes %s intents only to registered session panels",
    (delivery) => {
      const f = fixture();
      const stop = f.dispose;
      const send = (panelId: string, open: boolean) =>
        new CustomEvent(PLUGIN_PANEL_TOGGLE_EVENT, {
          detail: { pluginId: "review", panelId, sessionKey: "session-b", open },
        });
      try {
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
        expect(f.pending.size).toBe(0);
        expect(f.deliverPanelEvent).not.toHaveBeenCalled();
        window.dispatchEvent(send("document", false));
        expect(isSidebarSlotVisible(f.state.sidebarLayout, "plugin:review/document")).toBe(false);
      } finally {
        stop();
      }
    },
  );
});

describe("session link-reader intent delivery", () => {
  it.each(["ready", "closed", "session"] as const)(
    "waits for the recipient commit before delivering an intent (%s)",
    async (outcome) => {
      vi.useFakeTimers();
      const f = fixture();
      const recipientCommit = createDeferred<boolean>();
      const recipient = document.createElement("openclaw-link-reader-panel");
      Object.defineProperty(recipient, "updateComplete", { value: recipientCommit.promise });
      f.root.append(recipient);
      const event = f.event();
      window.dispatchEvent(event);
      f.definitions.resolve(HTMLElement);
      f.commit.resolve(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.deliverPanelEvent).not.toHaveBeenCalled();
      if (outcome === "closed") {
        window.dispatchEvent(
          new CustomEvent(LINK_READER_PANEL_TOGGLE_EVENT, { detail: { open: false } }),
        );
      } else if (outcome === "session") {
        f.state.sessionKey = "session-b";
      }
      recipientCommit.resolve(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.pending.size).toBe(0);
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
    expect(f.pending.size).toBe(0);
  });

  it("does not append a new session intent to a retired pending batch", async () => {
    const f = fixture();
    const old = f.event();
    window.dispatchEvent(old);
    f.state.sessionKey = "session-b";
    const current = f.event("https://forge.example/items/2");
    window.dispatchEvent(current);
    f.definitions.resolve(HTMLElement);
    f.commit.resolve(true);
    await vi.waitFor(() => expect(f.deliverPanelEvent).toHaveBeenCalledTimes(1));
    expect(f.deliverPanelEvent).toHaveBeenCalledWith("link-reader", current);
    expect(f.pending.size).toBe(0);
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
        window.dispatchEvent(
          new CustomEvent(LINK_READER_PANEL_TOGGLE_EVENT, { detail: { open: false } }),
        );
        expect(f.pending.size).toBe(0);
      } else if (change === "session") {
        f.state.sessionKey = "session-b";
      } else {
        f.owner.linkReaders = [];
      }
      f.definitions.resolve(HTMLElement);
      f.commit.resolve(true);
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
});

it("delivers a browser card after the pane's scheduled render commits", async () => {
  vi.useFakeTimers();
  stubScreenshotMedia();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const url = "http://127.0.0.1:18789/assets/example.html";
  const gateway = createBrowserClient(async (request) => {
    if (request.path === "/tabs" && request.query?.profile !== "managed") {
      return { running: true, tabs: [] };
    }
    if (request.path === "/tabs") {
      return {
        running: true,
        tabs: [{ tabId: "t1", targetId: "target-1", title: "Local preview", url }],
      };
    }
    if (request.path === "/screenshot") {
      return { path: "/proof/local.png", targetId: "target-1", url };
    }
    if (request.path === "/act") {
      return createBrowserPanelTestMetrics(url, "Local preview");
    }
    return { ok: true };
  });
  const commit = createDeferred();
  const pane = document.createElement("div");
  let pendingUpdate: Promise<void> | undefined;
  const state = createPageState(
    createInitializationContext(),
    { invalidate: requestUpdate, afterCommit: () => () => {} },
    pane,
  );
  state.sidebarLayout = { columns: [] };
  state.sessionKey = "agent:main:local-preview";
  const pending = new Map<SessionPanelToggleSlot, PendingSessionPanelToggle>();
  const dispose = createRoot((stop) => {
    createChatPaneSessionPanelToggles({
      current: () => ({
        renderRoot: pane,
        state,
        linkReaders: [],
        pluginPanels: [],
        updateComplete: pendingUpdate ?? Promise.resolve(),
      }),
      pending,
      requestUpdate,
      updateSidebarLayout: (layout) => {
        state.sidebarLayout = layout;
        requestUpdate();
      },
    });
    return stop;
  });
  onTestFinished(dispose);

  function BrowserCard(props: { sessionKey: string; presented: boolean; refresh: boolean }) {
    return (
      <openclaw-browser-panel
        data-sidebar-panel-host
        prop:embedded={true}
        prop:available={true}
        prop:client={gateway.client}
        prop:sessionKey={props.sessionKey}
        prop:presented={props.presented}
        prop:refreshOnPresentation={props.refresh}
      />
    );
  }
  const conversation = document.createElement("main");
  conversation.textContent = "Conversation";
  function draw() {
    renderPaneLegacyContent(
      renderSidebarRegion({
        presentationId: "delayed-browser-card",
        availableWidth: 1400,
        callbacks: {
          activatePanel: () => undefined,
          togglePanelExpanded: () => undefined,
          closeSlot: () => undefined,
          openSlot: () => undefined,
          reorderPanel: () => undefined,
          resizePanel: () => undefined,
          setOpen: () => undefined,
        },
        layout: state.sidebarLayout,
        narrow: false,
        panelDefinitions: sidebarPanelDefinitions().map((definition) =>
          Object.assign(definition, {
            available: definition.slot === "browser",
            content:
              definition.slot === "browser"
                ? solidContent(BrowserCard, {
                    sessionKey: state.sessionKey,
                    presented: isSidebarSlotVisible(state.sidebarLayout, "browser"),
                    refresh: !pending.has("browser"),
                  })
                : null,
          }),
        ),
        primary: conversation,
        requestUpdate,
      }),
      pane,
    );
  }
  function requestUpdate() {
    // Expose the new commit promise before the browser card can mount.
    pendingUpdate ??= commit.promise.then(() => {
      draw();
      pendingUpdate = undefined;
    });
  }
  document.body.append(pane);
  try {
    draw();
    window.dispatchEvent(
      new CustomEvent("openclaw:browser-toggle", {
        detail: {
          open: true,
          browserTab: { target: "host", profile: "managed", targetId: "target-1" },
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(pane.querySelector("openclaw-browser-panel")).toBeNull();
    commit.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await pendingUpdate;
    expect(gateway.request).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({
        path: "/tabs/focus",
        target: "host",
        query: { profile: "managed" },
        body: { targetId: "t1" },
      }),
    );
    expect(
      pane
        .querySelector("openclaw-browser-panel")
        ?.renderRoot?.querySelector(".bp-shot")
        ?.getAttribute("alt"),
    ).toBe("Local preview");
  } finally {
    commit.resolve();
    pane.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
