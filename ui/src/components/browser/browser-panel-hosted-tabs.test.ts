import { beforeEach, expect, it, vi } from "vitest";
import type { NativeBrowserTab } from "../../app/native-browser-bridge.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { PANEL_HOSTED_TABS_CHANGE_EVENT, readPanelHostedTabs } from "../panel-hosted-tabs.ts";
import {
  createBrowserClient,
  createBrowserPanelTestMetrics,
  createBrowserPanelTestTab,
  setupBrowserPanelTestCleanup,
  stubScreenshotMedia,
  openBrowserActions,
} from "./browser-panel-controller-test-support.ts";
import "./browser-panel.ts";

const favicon = "data:image/png;base64,eA==";
const nativeTab = {
  id: "native:b",
  title: "",
  url: "https://second.test/b",
  favicon,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  openedBy: "web",
} satisfies NativeBrowserTab;

function publishTabs(revision: number, tabs: NativeBrowserTab[]) {
  window.dispatchEvent(
    new CustomEvent("openclaw:native-browser-state", { detail: { revision, tabs } }),
  );
}

const query = (panel: HTMLElement, selector: string) => panel.querySelector<HTMLElement>(selector);
const icon = expect.any(SVGSVGElement);
const projectedTab = (id: string, label: string, url: string) => ({ id, label, url, icon });

setupBrowserPanelTestCleanup();

beforeEach(() => vi.stubGlobal("localStorage", createStorageMock()));

async function mount(embedded = true, tabsInHeader = true) {
  if (!embedded) {
    localStorage.setItem(
      "openclaw.browser.panel.v1",
      JSON.stringify({ open: true, dock: "right", height: 420, width: 560 }),
    );
  }
  stubScreenshotMedia();
  const bridge = { postMessage: vi.fn().mockResolvedValue({ ok: true }) };
  vi.stubGlobal("webkit", { messageHandlers: { openclawBrowser: bridge } });
  vi.stubGlobal("__OPENCLAW_NATIVE_BROWSER__", { revision: 0, tabs: [nativeTab] });
  const responses: Record<string, unknown> = {
    "/tabs": {
      running: true,
      tabs: [
        createBrowserPanelTestTab("remote:a", "https://example.test/a", "  Example  "),
        createBrowserPanelTestTab("remote:c", "about:blank", ""),
      ],
    },
    "/screenshot": { path: "/fresh.png", targetId: "raw-remote:a", url: "https://example.test/a" },
    "/act": createBrowserPanelTestMetrics("https://example.test/a", "Example"),
  };
  const gateway = createBrowserClient(async ({ path }) => responses[path] ?? { ok: true });
  const panel = document.createElement("openclaw-browser-panel");
  panel.available = true;
  panel.embedded = embedded;
  panel.presented = true;
  panel.tabsInHeader = tabsInHeader;
  panel.client = gateway.client;
  panel.preferredTab = {
    tab: { target: "host", profile: "default", targetId: "remote:a" },
    revision: "initial",
  };
  mountSolid(() => panel);
  await waitForSolid(() => expect(panel.querySelector(".bp-shot")).not.toBeNull());
  return { panel };
}

it.each([
  { embedded: true, tabsInHeader: true, ownsStrip: false },
  { embedded: true, tabsInHeader: false, ownsStrip: true },
  { embedded: false, tabsInHeader: true, ownsStrip: true },
])(
  "renders its own strip=$ownsStrip for embedded=$embedded and tabsInHeader=$tabsInHeader",
  async ({ embedded, tabsInHeader, ownsStrip }) => {
    const { panel } = await mount(embedded, tabsInHeader);
    expect(Boolean(panel.querySelector(".bp-header"))).toBe(ownsStrip);
    expect(Boolean(panel.querySelector(".tabstrip"))).toBe(ownsStrip);
    expect(panel.querySelector(".bp-toolbar")).not.toBeNull();
    const viewport = query(panel, ".bp-viewport")!;
    const activeTab = query(panel, '.tabstrip-tab[aria-selected="true"]');
    expect(viewport.getAttribute("aria-labelledby")).toBe(ownsStrip ? activeTab?.id : null);
    if (ownsStrip) {
      expect(activeTab).not.toBeNull();
      expect(activeTab?.getAttribute("aria-controls")).toBe(viewport.id);
    }
    if (embedded) {
      expect(panel.querySelector(".bp-header [data-new-tab-action]")).toBeNull();
      const menu = await openBrowserActions(panel);
      expect(menu.querySelector('[role="menuitem"][aria-label="New browser tab"]')).not.toBeNull();
    }
  },
);

it("projects remote and native tabs and keeps simultaneous panels' DOM associations separate", async () => {
  const { panel } = await mount(true, false);
  expect(readPanelHostedTabs(panel)).toBe(panel);
  const hostedTabs = panel.hostedTabs;
  expect(hostedTabs).toEqual([
    { ...projectedTab("native:b", "second.test", "https://second.test/b"), favicon },
    projectedTab("remote:a", "Example", "https://example.test/a"),
    projectedTab("remote:c", "New tab", "about:blank"),
  ]);
  expect(hostedTabs[0]!.icon).not.toBe(panel.hostedTabs[0]!.icon);
  expect(panel.activeHostedTabId).toBe("remote:a");
  expect(
    [...panel.querySelectorAll(".tabstrip-tab__label")].map((label) => label.textContent),
  ).toEqual(["second.test", "Example", "New tab"]);
  const nativeIcon = query(panel, ".tabstrip-tab__icon");
  expect(nativeIcon?.querySelector("img")?.getAttribute("src")).toBe(favicon);
  expect(nativeIcon?.querySelector("svg")).toBeNull();

  const second = await mount(true, false);
  for (const browser of [panel, second.panel]) {
    const viewport = query(browser, ".bp-viewport")!;
    expect(document.getElementById(viewport.id)).toBe(viewport);
    for (const tab of browser.querySelectorAll<HTMLElement>(".tabstrip-tab")) {
      expect(document.getElementById(tab.id)).toBe(tab);
      expect(tab.getAttribute("aria-controls")).toBe(viewport.id);
    }
    const activeTab = query(browser, '.tabstrip-tab[aria-selected="true"]')!;
    expect(viewport.getAttribute("aria-labelledby")).toBe(activeTab.id);
  }
});

it("publishes selection, title and favicon-only changes but not unrelated renders", async () => {
  const { panel } = await mount(true, false);
  const changed = vi.fn();
  document.body.addEventListener(PANEL_HOSTED_TABS_CHANGE_EVENT, changed);
  try {
    panel.selectHostedTab("native:b");
    await panel.updateComplete;
    expect(changed).toHaveBeenCalledTimes(1);
    const event = changed.mock.calls[0]?.[0];
    expect(event).toMatchObject({ target: panel, bubbles: true, composed: true });
    expect(panel.activeHostedTabId).toBe("native:b");

    publishTabs(1, [{ ...nativeTab, title: "Changed" }]);
    await panel.updateComplete;
    expect(changed).toHaveBeenCalledTimes(2);
    expect(panel.hostedTabs.map((tab) => tab.label)).toEqual(["Changed", "Example", "New tab"]);

    const { favicon: _previousIcon, ...withoutIcon } = { ...nativeTab, title: "Changed" };
    publishTabs(2, [withoutIcon]);
    await panel.updateComplete;
    expect(panel.hostedTabs[0]?.favicon).toBeUndefined();
    expect(panel.querySelector("img.tabstrip-tab__favicon")).toBeNull();
    expect(changed).toHaveBeenCalledTimes(3);
    publishTabs(3, [{ ...withoutIcon, favicon }]);
    await panel.updateComplete;
    expect(panel.hostedTabs[0]?.favicon).toBe(favicon);
    expect(panel.querySelector("img.tabstrip-tab__favicon")?.getAttribute("src")).toBe(favicon);
    expect(changed).toHaveBeenCalledTimes(4);

    const address = panel.querySelector<HTMLInputElement>(".bp-url")!;
    address.value = "https://draft.test/";
    address.dispatchEvent(new Event("input", { bubbles: true }));
    await panel.updateComplete;
    panel.tabsInHeader = true;
    await panel.updateComplete;
    expect(changed).toHaveBeenCalledTimes(4);
  } finally {
    document.body.removeEventListener(PANEL_HOSTED_TABS_CHANGE_EVENT, changed);
  }
});
