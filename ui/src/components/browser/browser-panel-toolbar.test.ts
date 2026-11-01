import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { NativeBrowserMessage, NativeBrowserTab } from "../../app/native-browser-bridge.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { restorePropertyDescriptor } from "../../test-helpers/property-descriptor.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { PANEL_HOSTED_TABS_CHANGE_EVENT } from "../panel-hosted-tabs.ts";
import {
  createBrowserClient,
  createBrowserPanelTestMetrics,
  createBrowserPanelTestTab,
  setupBrowserPanelTestCleanup,
  stubScreenshotMedia,
  openBrowserActions,
} from "./browser-panel-controller-test-support.ts";
import { createBrowserPageClient } from "./test-helpers/browser-page.ts";
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
function panelFor(client: HTMLElementTagNameMap["openclaw-browser-panel"]["client"]) {
  const panel = document.createElement("openclaw-browser-panel");
  panel.available = panel.embedded = panel.presented = true;
  panel.client = client;
  return panel;
}

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
  const panel = panelFor(gateway.client);
  panel.embedded = embedded;
  panel.tabsInHeader = tabsInHeader;
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
    if (!ownsStrip) {
      expect(query(panel, ".bp-viewport")!.getAttribute("aria-labelledby")).toBeNull();
    }
    if (embedded) {
      expect(panel.querySelector(".bp-header [data-new-tab-action]")).toBeNull();
      const menu = await openBrowserActions(panel);
      expect(menu.querySelector('[role="menuitem"][aria-label="New browser tab"]')).not.toBeNull();
    }
  },
);

it("renders tab labels and keeps simultaneous panels' DOM associations separate", async () => {
  const { panel } = await mount(true, false);
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
    expect(panel.querySelector("img.tabstrip-tab__favicon")).toBeNull();
    expect(changed).toHaveBeenCalledTimes(3);
    publishTabs(3, [{ ...withoutIcon, favicon }]);
    await panel.updateComplete;
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

describe("Browser toolbar", () => {
  async function mountToolbar() {
    stubScreenshotMedia();
    const panel = panelFor(createBrowserPageClient("asset", "https://assets.test/a.png").client);
    mountSolid(() => panel);
    await waitForSolid(() => expect(panel.querySelector(".bp-shot")).not.toBeNull());
    return panel;
  }

  const toolbarFavicon = (panel: HTMLElement) =>
    panel.querySelector<HTMLImageElement>(".bp-toolbar-favicon img");

  it("retires replaced favicon requests without replacing the address draft or focus", async () => {
    const panel = await mountToolbar();
    const input = panel.querySelector<HTMLInputElement>(".bp-url")!;
    input.focus();
    input.value = "https://draft.example.test/uncommitted";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await panel.updateComplete;
    input.setSelectionRange(8, 13);
    const toolbar = panel.querySelector(".bp-toolbar");
    const retired = createDeferred<string | null>();
    const current = createDeferred<string | null>();
    const firstFetcher = vi.fn(() => retired.promise);
    const currentFetcher = vi.fn(() => current.promise);
    panel.fetchFavicon = firstFetcher;
    await waitForSolid(() => expect(firstFetcher).toHaveBeenCalledOnce());
    panel.fetchFavicon = currentFetcher;
    await waitForSolid(() => expect(currentFetcher).toHaveBeenCalledOnce());
    expect(toolbarFavicon(panel)).toBeNull();

    const currentUrl = "data:image/png;base64,Y3VycmVudA==";
    current.resolve(currentUrl);
    await waitForSolid(() => expect(toolbarFavicon(panel)?.getAttribute("src")).toBe(currentUrl));
    retired.resolve("data:image/png;base64,cmV0aXJlZA==");
    await retired.promise;
    await panel.updateComplete;
    expect(toolbarFavicon(panel)?.getAttribute("src")).toBe(currentUrl);
    expect(panel.querySelector(".bp-toolbar")).toBe(toolbar);
    expect(panel.querySelector(".bp-url")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input).toMatchObject({
      value: "https://draft.example.test/uncommitted",
      selectionStart: 8,
      selectionEnd: 13,
    });

    toolbarFavicon(panel)!.dispatchEvent(new Event("error"));
    await waitForSolid(() => expect(toolbarFavicon(panel)).toBeNull());
    expect(panel.querySelector(".bp-toolbar-favicon svg")).not.toBeNull();
  });

  it("renders the download's Gateway error and HTTP status", async () => {
    const panel = await mountToolbar();
    const error = { error: { message: "Unauthorized", type: "unauthorized" } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(error, { status: 401 })));
    (await openBrowserActions(panel))
      .querySelector<HTMLElement>('[aria-label="Download file"]')!
      .click();
    await waitForSolid(() => expect(panel.textContent).toContain("HTTP 401: Unauthorized"));
  });

  it("updates download state without replacing the preview", async () => {
    const panel = await mountToolbar();
    const body = createDeferred<Blob>();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: () => body.promise }));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const preview = panel.querySelector(".bp-shot");
    const menu = await openBrowserActions(panel);
    const download = (label = "Download file") =>
      menu.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
    let button = download();
    const expectPreview = () => {
      expect(panel.querySelector(".bp-note")).toBeNull();
      expect(panel.querySelector(".bp-shot")).toBe(preview);
    };
    const downloadShape = button.querySelector("svg")!.innerHTML;
    button.click();
    await panel.updateComplete;
    await openBrowserActions(panel);
    button = download("Downloading…");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.querySelector("svg")!.innerHTML).not.toBe(downloadShape);
    expectPreview();

    body.resolve(new Blob(["complete asset"], { type: "image/png" }));
    await waitForSolid(() => {
      button = download();
      expect(button?.getAttribute("aria-busy")).toBe("false");
    });
    expect(button.getAttribute("aria-disabled")).not.toBe("true");
    expect(button.querySelector("svg")!.innerHTML).toBe(downloadShape);
    expectPreview();
  });
});

describe("Browser recovery", () => {
  let originalFonts: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: Object.assign(new EventTarget(), { ready: Promise.resolve() }),
    });
    vi.stubGlobal("ResizeObserver", undefined);
  });

  afterEach(() => {
    document.body.replaceChildren();
    restorePropertyDescriptor(document, "fonts", originalFonts);
  });

  function mountFailingBrowser(nativeAvailable: boolean, remoteAvailable: boolean) {
    const nativeMessages: NativeBrowserMessage[] = [];
    if (nativeAvailable) {
      const postMessage = async (message: NativeBrowserMessage) => {
        nativeMessages.push(message);
        return message.type === "open"
          ? { ok: false, error: "Synthetic browser failure" }
          : { ok: true };
      };
      vi.stubGlobal("webkit", { messageHandlers: { openclawBrowser: { postMessage } } });
      vi.stubGlobal("__OPENCLAW_NATIVE_BROWSER__", { revision: 0, tabs: [] });
    }
    const { client, request } = createBrowserClient(async () => {
      throw new Error("Synthetic browser failure");
    });
    const panel = panelFor(client);
    panel.remoteAvailable = remoteAvailable;
    const mounted = mountSolid(() => panel);
    const recovery = () => mounted.getByRole("button", { name: /^(Retry|Refresh)$/ });
    return { panel, mounted, recovery, request, nativeMessages };
  }

  it.each([
    ["native", false],
    ["native", true],
    ["remote", false],
    ["remote", true],
  ] as const)("retries %s with the alternate backend available=%s", async (backend, alternate) => {
    const native = backend === "native";
    const { panel, mounted, recovery, request, nativeMessages } = mountFailingBrowser(
      native || alternate,
      !native || alternate,
    );
    const opens = () => nativeMessages.filter((message) => message.type === "open");
    await panel.updateComplete;
    if (!native || alternate) {
      await waitForSolid(() => expect(recovery()).toBeTruthy());
    }
    if (native) {
      const address = mounted.getByRole("textbox", { name: "Page address" });
      Object.assign(address, { value: "https://example.test/first-native" });
      address.dispatchEvent(new Event("input", { bubbles: true }));
      address.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await waitForSolid(() => {
        expect(opens()).toHaveLength(1);
        expect(recovery()).toBeTruthy();
      });
    }
    const remoteCalls = request.mock.calls.length;
    recovery().click();
    await waitForSolid(() => {
      expect(request).toHaveBeenCalledTimes(remoteCalls + (native ? 0 : 1));
      expect(opens()).toHaveLength(native ? 2 : 0);
      expect(recovery()).toBeTruthy();
    });
    if (native) {
      for (const message of opens()) {
        expect(message.url).toBe("https://example.test/first-native");
      }
    } else {
      expect(request.mock.lastCall?.[1]).toMatchObject({ method: "GET", path: "/tabs" });
    }
    expect(panel.textContent).toContain("Synthetic browser failure");
    expect(panel.querySelector(".bp-shot")).toBeNull();
  });
});
