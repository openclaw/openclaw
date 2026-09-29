import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { icons } from "../icons.ts";
import { PANEL_HOSTED_TABS_CHANGE_EVENT, readPanelHostedTabs } from "../panel-hosted-tabs.ts";
import type { BrowserPanelTab } from "./browser-client.ts";
import type { BrowserPanelController } from "./browser-panel-controller.ts";
import "./browser-panel.ts";

const favicon = "data:image/png;base64,eA==";

describe("Browser panel hosted tabs", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("ResizeObserver", undefined);
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function mount(embedded = true, tabsInHeader = true) {
    if (!embedded) {
      localStorage.setItem(
        "openclaw.browser.panel.v1",
        JSON.stringify({ open: true, dock: "right", height: 420, width: 560 }),
      );
    }
    const panel = document.createElement("openclaw-browser-panel");
    panel.available = true;
    panel.embedded = embedded;
    panel.tabsInHeader = tabsInHeader;
    document.body.append(panel);
    await panel.updateComplete;
    const controller = (panel as unknown as { browserPanelController: BrowserPanelController })
      .browserPanelController;
    const tabs: BrowserPanelTab[] = [
      {
        id: "remote:a",
        targetId: "raw-a",
        title: "  Example  ",
        url: "https://example.test/a",
        kind: "remote",
      },
      {
        id: "native:b",
        targetId: "raw-b",
        title: "",
        url: "https://second.test/b",
        kind: "native",
        favicon,
      },
      { id: "remote:c", targetId: "raw-c", title: "", url: "about:blank", kind: "remote" },
    ];
    controller.setState("tabs", tabs);
    controller.setState("activeTargetId", "remote:a");
    await panel.updateComplete;
    return { panel, controller };
  }

  it.each([
    { embedded: true, tabsInHeader: true, ownsStrip: false },
    { embedded: true, tabsInHeader: false, ownsStrip: true },
    { embedded: false, tabsInHeader: true, ownsStrip: true },
  ])(
    "renders its own strip=$ownsStrip for embedded=$embedded and tabsInHeader=$tabsInHeader",
    async ({ embedded, tabsInHeader, ownsStrip }) => {
      const { panel } = await mount(embedded, tabsInHeader);
      expect(Boolean(panel.shadowRoot?.querySelector(".bp-header"))).toBe(ownsStrip);
      expect(Boolean(panel.shadowRoot?.querySelector("wa-tab-group"))).toBe(ownsStrip);
      expect(panel.shadowRoot?.querySelector(".bp-toolbar")).not.toBeNull();
      expect(panel.shadowRoot?.querySelector(".bp-viewport")?.getAttribute("aria-labelledby")).toBe(
        ownsStrip ? "browser-tab-remote:a" : null,
      );
      if (embedded) {
        expect(panel.shadowRoot?.querySelector(".bp-header [data-new-tab-action]")).toBeNull();
        expect(panel.shadowRoot?.querySelector(".bp-toolbar [data-new-tab-action]")).not.toBeNull();
      }
    },
  );

  it("projects controller tabs with the same labels as the panel's own strip", async () => {
    const { panel } = await mount(true, false);
    expect(readPanelHostedTabs(panel)).toBe(panel);
    expect(panel.hostedTabs).toEqual([
      { id: "remote:a", label: "Example", url: "https://example.test/a", icon: icons.globe },
      {
        id: "native:b",
        label: "second.test",
        url: "https://second.test/b",
        icon: icons.monitor,
        favicon,
      },
      { id: "remote:c", label: "New tab", url: "about:blank", icon: icons.globe },
    ]);
    expect(panel.activeHostedTabId).toBe("remote:a");
    expect(
      [...panel.shadowRoot!.querySelectorAll(".tabstrip-tab__label")].map(
        (label) => label.textContent,
      ),
    ).toEqual(["Example", "second.test", "New tab"]);
    const nativeIcon = panel.shadowRoot!.querySelector(
      "#browser-tab-native\\:b .tabstrip-tab__icon",
    );
    expect(nativeIcon?.querySelector("img")?.getAttribute("src")).toBe(favicon);
    expect(nativeIcon?.querySelector("svg")).toBeNull();
  });

  it("delegates hosted selection and close to the controller", async () => {
    const { panel, controller } = await mount();
    const select = vi.spyOn(controller, "selectTab").mockResolvedValue();
    const close = vi.spyOn(controller, "closeTab").mockResolvedValue();

    panel.selectHostedTab("native:b");
    await panel.closeHostedTab("remote:a");

    expect(select).toHaveBeenCalledWith("native:b");
    expect(close).toHaveBeenCalledWith("remote:a");
  });

  it("publishes favicon-only native pushes to hosted tabs and the dock strip", async () => {
    const tab = {
      id: "mac-icon",
      sessionKey: "session-icon",
      url: "https://example.test/page",
      title: "Example page",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      openedBy: "web",
    };
    vi.stubGlobal("webkit", {
      messageHandlers: {
        openclawBrowser: { postMessage: vi.fn().mockResolvedValue({ ok: true }) },
      },
    });
    vi.stubGlobal("__OPENCLAW_NATIVE_BROWSER__", { revision: 0, tabs: [tab] });
    const panel = document.createElement("openclaw-browser-panel");
    panel.sessionKey = tab.sessionKey;
    panel.available = true;
    panel.remoteAvailable = false;
    panel.embedded = true;
    panel.presented = true;
    document.body.append(panel);
    await panel.updateComplete;
    const changed = vi.fn();
    panel.addEventListener(PANEL_HOSTED_TABS_CHANGE_EVENT, changed);
    window.dispatchEvent(
      new CustomEvent("openclaw:native-browser-state", {
        detail: { revision: 1, tabs: [{ ...tab, favicon }] },
      }),
    );
    await panel.updateComplete;
    expect(panel.hostedTabs[0]?.favicon).toBe(favicon);
    expect(panel.shadowRoot?.querySelector("img.tabstrip-tab__favicon")?.getAttribute("src")).toBe(
      favicon,
    );
    expect(changed).toHaveBeenCalledOnce();
    window.dispatchEvent(
      new CustomEvent("openclaw:native-browser-state", {
        detail: { revision: 2, tabs: [tab] },
      }),
    );
    await panel.updateComplete;
    expect(panel.hostedTabs[0]?.favicon).toBeUndefined();
    expect(panel.shadowRoot?.querySelector("img.tabstrip-tab__favicon")).toBeNull();
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("notifies the host of tab and active changes but not unrelated renders", async () => {
    const { panel, controller } = await mount();
    const changed = vi.fn();
    document.body.addEventListener(PANEL_HOSTED_TABS_CHANGE_EVENT, changed);
    try {
      controller.setState("activeTargetId", "native:b");
      await panel.updateComplete;
      expect(changed).toHaveBeenCalledTimes(1);
      expect(changed.mock.calls[0]?.[0]).toMatchObject({
        target: panel,
        bubbles: true,
        composed: true,
      });
      expect(panel.activeHostedTabId).toBe("native:b");

      controller.setState(
        "tabs",
        controller.tabs.map((tab) => ({ ...tab, title: "Changed" })),
      );
      await panel.updateComplete;
      expect(changed).toHaveBeenCalledTimes(2);
      expect(panel.hostedTabs.map((tab) => tab.label)).toEqual(["Changed", "Changed", "Changed"]);

      controller.setState(
        "tabs",
        controller.tabs.map((tab) => ({ ...tab, favicon: undefined })),
      );
      await panel.updateComplete;
      expect(changed).toHaveBeenCalledTimes(3);
      expect(panel.hostedTabs.every((tab) => tab.favicon === undefined)).toBe(true);

      controller.setState("urlDraft", "https://draft.test/");
      await panel.updateComplete;
      panel.requestUpdate();
      await panel.updateComplete;
      expect(changed).toHaveBeenCalledTimes(3);
    } finally {
      document.body.removeEventListener(PANEL_HOSTED_TABS_CHANGE_EVENT, changed);
    }
  });
});
