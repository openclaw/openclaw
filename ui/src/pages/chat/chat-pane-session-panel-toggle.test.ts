import { html, LitElement } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./components/chat-sidebar-region.runtime.ts";
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
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import {
  ChatPaneSessionPanelToggleController,
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
  const region = document.createElement("div");
  const deliverPanelEvent = vi.fn();
  Object.assign(region, { updateComplete: commit.promise, deliverPanelEvent });
  const root = document.createElement("div");
  vi.spyOn(root, "querySelector").mockReturnValue(region);
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
  const controller = new ChatPaneSessionPanelToggleController({
    current: () => owner,
    pending,
    requestUpdate,
    updateSidebarLayout,
  });
  const event = (url = "https://forge.example/items/1") =>
    new CustomEvent(LINK_READER_PANEL_TOGGLE_EVENT, {
      cancelable: true,
      detail: { url, open: true },
    });
  return {
    controller,
    definitions,
    commit,
    deliverPanelEvent,
    event,
    owner,
    pending,
    state,
    updateSidebarLayout,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("plugin panel intent delivery", () => {
  it.each(["buffered", "direct"] as const)(
    "routes %s intents only to registered session panels",
    (delivery) => {
      const f = fixture();
      const stop = f.controller.subscribe();
      const send = (panelId: string, open: boolean) =>
        new CustomEvent(PLUGIN_PANEL_TOGGLE_EVENT, {
          detail: { pluginId: "review", panelId, sessionKey: "session-b", open },
        });
      try {
        const event = send("document", true);
        if (delivery === "buffered") {
          rememberSessionPanelToggle("plugin:review/document", event);
          f.controller.flush();
        } else {
          window.dispatchEvent(event);
        }
        expect(f.updateSidebarLayout).not.toHaveBeenCalled();
        f.state.sessionKey = "session-b";
        window.dispatchEvent(send("missing", true));
        expect(f.updateSidebarLayout).not.toHaveBeenCalled();
        if (delivery === "buffered") {
          f.controller.flush();
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
  it("delivers every buffered reader intent in order after the lazy commit", async () => {
    const f = fixture();
    const first = f.event();
    const second = f.event("https://forge.example/items/2");
    rememberSessionPanelToggle("link-reader", first);
    rememberSessionPanelToggle("link-reader", second);
    f.controller.flush();
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
    f.controller.handle("link-reader", "openclaw-link-reader-panel", old);
    f.state.sessionKey = "session-b";
    const current = f.event("https://forge.example/items/2");
    f.controller.handle("link-reader", "openclaw-link-reader-panel", current);
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
      f.controller.handle("link-reader", "openclaw-link-reader-panel", f.event());
      f.controller.handle(
        "link-reader",
        "openclaw-link-reader-panel",
        f.event("https://forge.example/items/2"),
      );
      if (ready) {
        f.definitions.resolve(HTMLElement);
        await Promise.resolve();
        await Promise.resolve();
      }
      if (change === "close") {
        f.controller.handle(
          "link-reader",
          "openclaw-link-reader-panel",
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
    expect(f.controller.handle("link-reader", "openclaw-link-reader-panel", event)).toBe(false);
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
  class ScheduledBrowserPane extends LitElement {
    readonly state = createPageState(
      createInitializationContext(),
      { invalidate: () => this.requestUpdate(), afterCommit: () => () => {} },
      this,
    );
    readonly pending = new Map<SessionPanelToggleSlot, PendingSessionPanelToggle>();
    readonly toggles = new ChatPaneSessionPanelToggleController({
      current: () => ({
        renderRoot: this,
        state: this.state,
        linkReaders: [],
        pluginPanels: [],
        updateComplete: this.updateComplete,
      }),
      pending: this.pending,
      requestUpdate: () => this.requestUpdate(),
      updateSidebarLayout: (layout) => {
        this.state.sidebarLayout = layout;
        this.requestUpdate();
      },
    });
    override createRenderRoot() {
      return this;
    }
    protected override async scheduleUpdate() {
      if (this.hasUpdated) {
        await commit.promise;
      }
      await super.scheduleUpdate();
    }
    override render() {
      return renderSidebarRegion({
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
        layout: this.state.sidebarLayout,
        narrow: false,
        panelDefinitions: sidebarPanelDefinitions().map((definition) =>
          Object.assign(definition, {
            available: definition.slot === "browser",
            content:
              definition.slot === "browser"
                ? html`<openclaw-browser-panel
                    embedded
                    .available=${true}
                    .client=${gateway.client}
                    .sessionKey=${this.state.sessionKey}
                    .presented=${isSidebarSlotVisible(this.state.sidebarLayout, "browser")}
                    .refreshOnPresentation=${!this.pending.has("browser")}
                  ></openclaw-browser-panel>`
                : null,
          }),
        ),
        primary: html`<main>Conversation</main>`,
        requestUpdate: () => this.requestUpdate(),
      });
    }
  }
  customElements.define("scheduled-browser-pane", ScheduledBrowserPane);
  const pane = document.createElement("scheduled-browser-pane") as ScheduledBrowserPane;
  pane.state.sidebarLayout = { columns: [] };
  pane.state.sessionKey = "agent:main:local-preview";
  document.body.append(pane);
  try {
    await pane.updateComplete;
    pane.toggles.handle(
      "browser",
      "openclaw-browser-panel",
      new CustomEvent("openclaw:browser-toggle", {
        detail: {
          open: true,
          browserTab: { target: "host", profile: "managed", targetId: "target-1" },
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    commit.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await pane.updateComplete;
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
