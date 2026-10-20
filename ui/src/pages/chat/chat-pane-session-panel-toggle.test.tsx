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
  TERMINAL_PANEL_TOGGLE_EVENT,
} from "../../components/panel-toggle-contract.ts";
import {
  rememberSessionPanelToggle,
  type SessionPanelToggleSlot,
} from "../../components/session-panel-toggle-buffer.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import {
  createChatPaneSessionPanelToggles,
  type PendingSessionPanelToggle,
} from "./chat-pane-session-panel-toggle.ts";
import { mountState, SidebarFixture } from "./chat-pane-sidebar-fixture.test-support.tsx";
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
} from "./chat-pane.test-support.ts";
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

function pageState(root: HTMLElement) {
  const state = createPageState(
    createInitializationContext(),
    { afterCommit: () => () => {} },
    root,
  );
  state.sidebarLayout = { columns: [] };
  return state;
}

type ToggleOptions = Parameters<typeof createChatPaneSessionPanelToggles>[0];
function bindToggles(
  current: ToggleOptions["current"],
  updateSidebarLayout: ToggleOptions["updateSidebarLayout"],
) {
  const pending = { requests: new Map<SessionPanelToggleSlot, PendingSessionPanelToggle>() };
  let flush!: () => void;
  onTestFinished(
    createRoot((dispose) => {
      flush = createChatPaneSessionPanelToggles({ current, pending, updateSidebarLayout });
      return dispose;
    }),
  );
  return { pending, flush };
}

const dispatch = (detail: object) =>
  window.dispatchEvent(new CustomEvent(LINK_READER_PANEL_TOGGLE_EVENT, { detail }));

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
  const state = pageState(root);
  state.connected = true;
  state.client = createGatewayBrowserClientFixture();
  state.sessionKey = "session-a";
  const owner = {
    sidebarRegion: region,
    state,
    linkReaders: [reader],
    pluginPanels: ["review/document"] as const,
    awaitDomCommit: () => Promise.resolve(),
  };
  const updateSidebarLayout = vi.fn((layout: typeof state.sidebarLayout) => {
    state.sidebarLayout = layout;
  });
  const { pending, flush } = bindToggles(() => owner, updateSidebarLayout);

  const event = (url = "https://forge.example/items/1") =>
    new CustomEvent(LINK_READER_PANEL_TOGGLE_EVENT, {
      cancelable: true,
      detail: { url, open: true },
    });
  return Object.assign(owner, {
    flush,
    definitions,
    commit,
    deliverPanelEvent,
    event,
    pending,
    updateSidebarLayout,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("opens the terminal while the sidebar region bridge awaits upgrade", () => {
  const f = fixture();
  // The pane creates the host before the lazy sidebar renderer registers its bridge.
  Object.defineProperty(f.sidebarRegion, "activateTerminalHost", { value: undefined });
  window.dispatchEvent(new Event(TERMINAL_PANEL_TOGGLE_EVENT));
  expect(isSidebarSlotVisible(f.state.sidebarLayout, "terminal")).toBe(true);
});

it.each(["buffered", "direct"] as const)(
  "routes %s intents only to registered session panels",
  (delivery) => {
    const f = fixture();
    const send = (panelId: string, open: boolean) =>
      new CustomEvent(PLUGIN_PANEL_TOGGLE_EVENT, {
        detail: { pluginId: "review", panelId, sessionKey: "session-b", open },
      });
    const event = send("document", true);
    const deliver = () => (delivery === "buffered" ? f.flush() : window.dispatchEvent(event));
    if (delivery === "buffered") {
      rememberSessionPanelToggle("plugin:review/document", event);
    }
    deliver();
    expect(f.updateSidebarLayout).not.toHaveBeenCalled();
    f.state.sessionKey = "session-b";
    window.dispatchEvent(send("missing", true));
    expect(f.updateSidebarLayout).not.toHaveBeenCalled();
    deliver();
    expect(isSidebarSlotVisible(f.state.sidebarLayout, "plugin:review/document")).toBe(true);
    expect(f.pending.requests.size).toBe(0);
    expect(f.deliverPanelEvent).not.toHaveBeenCalled();
    window.dispatchEvent(send("document", false));
    expect(isSidebarSlotVisible(f.state.sidebarLayout, "plugin:review/document")).toBe(false);
  },
);

describe("session link-reader intent delivery", () => {
  it.each([
    ["recipient", "ready"],
    ["recipient", "close"],
    ["recipient", "session"],
    ["definitions", "close"],
    ["region", "close"],
    ["region", "session"],
    ["region", "capability"],
  ] as const)("revalidates %s readiness after %s", async (stage, change) => {
    if (stage === "recipient") {
      vi.useFakeTimers();
    }
    const f = fixture();
    const recipientCommit = createDeferred<boolean>();
    if (stage === "recipient") {
      const recipient = document.createElement("openclaw-link-reader-panel");
      Object.defineProperty(recipient, "updateComplete", { value: recipientCommit.promise });
      f.sidebarRegion.after(recipient);
      f.sidebarRegion.readPanelHost = () => recipient;
    }
    const event = f.event();
    window.dispatchEvent(event);
    if (stage !== "recipient") {
      window.dispatchEvent(f.event("https://forge.example/items/2"));
    }
    if (stage !== "definitions") {
      f.definitions.resolve(HTMLElement);
      if (stage === "recipient") {
        f.commit.resolve(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(f.deliverPanelEvent).not.toHaveBeenCalled();
      } else {
        await Promise.resolve();
        await Promise.resolve();
      }
    }
    if (change === "close") {
      dispatch({ open: false });
      expect(f.pending.requests.size).toBe(0);
    } else if (change === "session") {
      f.state.sessionKey = "session-b";
    } else if (change === "capability") {
      f.linkReaders = [];
    }
    f.definitions.resolve(HTMLElement);
    f.commit.resolve(true);
    if (stage === "recipient") {
      recipientCommit.resolve(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.pending.requests.size).toBe(0);
    } else {
      await f.commit.promise;
      await Promise.resolve();
      await Promise.resolve();
    }
    if (change === "ready") {
      expect(f.deliverPanelEvent).toHaveBeenCalledExactlyOnceWith("link-reader", event);
    } else {
      expect(f.deliverPanelEvent).not.toHaveBeenCalled();
    }
  });

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
    f.definitions.resolve(HTMLElement);
    f.commit.resolve(true);
    await vi.waitFor(() => expect(f.deliverPanelEvent).toHaveBeenCalledTimes(1));
    expect(f.deliverPanelEvent).toHaveBeenCalledWith("link-reader", current);
    expect(f.pending.requests.size).toBe(0);
  });

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
    if (request.path === "/tabs") {
      return {
        running: true,
        tabs:
          request.query?.profile === "managed"
            ? [{ tabId: "t1", targetId: "target-1", title: "Local preview", url }]
            : [],
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
  const state = pageState(pane);
  state.sessionKey = "agent:main:local-preview";
  let pendingUpdate: Promise<void> | undefined;
  let sidebarRegion: HTMLElementTagNameMap["openclaw-chat-sidebar-region"] | null = null;
  let browserPanel: HTMLElement | undefined;
  const readSnapshot = () => ({
    layout: state.sidebarLayout,
    sessionKey: state.sessionKey,
    refresh: !pending.requests.has("browser"),
  });
  let view: ReturnType<typeof mountState<ReturnType<typeof readSnapshot>>> | undefined;
  const { pending } = bindToggles(
    () => ({
      sidebarRegion,
      state,
      linkReaders: [],
      pluginPanels: [],
      awaitDomCommit: () => pendingUpdate ?? Promise.resolve(),
    }),
    (layout) => {
      state.sidebarLayout = layout;
      pendingUpdate ??= commit.promise.then(() => {
        view!.update(readSnapshot());
        pendingUpdate = undefined;
      });
    },
  );
  document.body.append(pane);
  try {
    view = mountState(
      readSnapshot(),
      (props) => {
        const definitions = sidebarPanelDefinitions();
        for (const definition of definitions) {
          definition.available = definition.slot === "browser";
          if (definition.available) {
            Object.defineProperty(definition, "panelHost", { get: () => browserPanel });
            definition.content = (
              <openclaw-browser-panel
                ref={(element) => (browserPanel = element)}
                data-sidebar-panel-host
                prop:embedded={true}
                prop:available={true}
                prop:client={gateway.client}
                prop:sessionKey={props.value.sessionKey}
                prop:presented={isSidebarSlotVisible(props.value.layout, "browser")}
                prop:refreshOnPresentation={props.value.refresh}
              />
            );
          }
        }
        return (
          <SidebarFixture
            presentationId="delayed-browser-card"
            onRegionViewRef={(element) => {
              sidebarRegion = element;
              return () => {
                if (sidebarRegion === element) {
                  sidebarRegion = null;
                }
              };
            }}
            layout={props.value.layout}
            panelDefinitions={definitions}
            primary={<main>Conversation</main>}
          />
        );
      },
      { container: pane },
    );
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
      pane.querySelector("openclaw-browser-panel")?.querySelector(".bp-shot")?.getAttribute("alt"),
    ).toBe("Local preview");
  } finally {
    commit.resolve();
    view?.unmount();
    pane.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
