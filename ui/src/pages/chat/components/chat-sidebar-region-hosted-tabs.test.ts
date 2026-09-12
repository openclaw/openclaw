/* @vitest-environment jsdom */

import { html } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PANEL_HOSTED_TABS_CHANGE_EVENT,
  type PanelHostedTab,
  type PanelHostedTabsElement,
} from "../../../components/panel-hosted-tabs.ts";
import type { LinkFaviconFetcher } from "../link-favicon-loader.ts";
import { activatePanel, openSlot } from "../sidebar-layout.ts";
import "./chat-sidebar-region.runtime.ts";

const shells: HTMLElement[] = [];
const firstTab: PanelHostedTab = {
  id: "remote:page:1",
  label: "First page",
  url: "https://first.example/a",
  kind: "remote",
};
const secondTab: PanelHostedTab = {
  id: "native:page:2",
  label: "Second page",
  url: "https://second.example/b",
  kind: "native",
};
const tabs = [firstTab, secondTab];

async function mount(options: { tabs?: PanelHostedTab[]; fetchFavicon?: LinkFaviconFetcher } = {}) {
  const panel = Object.assign(document.createElement("div"), {
    hostedTabs: options.tabs ?? tabs,
    activeHostedTabId: "remote:page:1",
    selectHostedTab: vi.fn(),
    closeHostedTab: vi.fn().mockResolvedValue(undefined),
  }) satisfies PanelHostedTabsElement;
  const region = document.createElement("openclaw-chat-sidebar-region");
  region.layout = activatePanel(
    openSlot(openSlot(openSlot({ columns: [] }, "detail"), "browser"), "workspace"),
    "browser",
  );
  region.panelTemplates = { browser: html`${panel}` };
  region.fetchFavicon = options.fetchFavicon;
  region.callbacks = {
    activatePanel: vi.fn(),
    togglePanelExpanded: vi.fn(),
    closeSlot: vi.fn(),
    openSlot: vi.fn(),
    reorderPanel: vi.fn(),
    resizePanel: vi.fn(),
    setOpen: vi.fn(),
  };
  const shell = document.createElement("div");
  shell.className = "sidebar-region";
  const content = document.createElement("div");
  content.className = "sidebar-region__right-runtime";
  shell.append(region, content);
  document.body.append(shell);
  shells.push(shell);
  await region.updateComplete;
  const changed = async () => {
    panel.dispatchEvent(
      new CustomEvent(PANEL_HOSTED_TABS_CHANGE_EVENT, { bubbles: true, composed: true }),
    );
    await region.updateComplete;
  };
  await changed();
  return { panel, region, shell, changed };
}

function labels(shell: HTMLElement) {
  return [...shell.querySelectorAll("wa-tab .tabstrip-tab__label")].map(
    (label) => label.textContent,
  );
}

afterEach(() => {
  for (const shell of shells.splice(0)) {
    shell.remove();
  }
});

describe("chat sidebar hosted Browser tabs", () => {
  it("replaces Browser with its tabs, selects the active page and brackets the group", async () => {
    const { shell } = await mount();
    expect(labels(shell)).toEqual(["Review", "First page", "Second page", "Files"]);
    expect(shell.querySelector("wa-tab[active]")?.getAttribute("panel")).toBe(
      "hosted:browser:remote:page:1",
    );
    const hostedTab = shell.querySelector('[id="side-panel-tab-browser-remote:page:1"]')!;
    expect(hostedTab.hasAttribute("title")).toBe(false);
    expect(hostedTab.querySelector("openclaw-tooltip")?.content).toBe("First page");
    expect(hostedTab.hasAttribute("draggable")).toBe(false);
    const separators = [...shell.querySelectorAll(".tabstrip-separator")];
    expect(
      separators.map((separator) => separator.nextElementSibling?.getAttribute("panel")),
    ).toEqual(["hosted:browser:remote:page:1", "workspace"]);
  });

  it("activates the Browser panel before selecting a hosted id containing colons", async () => {
    const { region, panel, shell } = await mount();
    region.layout = activatePanel(region.layout, "workspace");
    await region.updateComplete;
    shell.querySelector("wa-tab-group")!.dispatchEvent(
      new CustomEvent("wa-tab-show", {
        bubbles: true,
        detail: { name: "hosted:browser:native:page:2" },
      }),
    );
    expect(region.callbacks!.activatePanel).toHaveBeenCalledExactlyOnceWith("browser");
    expect(panel.selectHostedTab).toHaveBeenCalledExactlyOnceWith("native:page:2");
    expect(region.callbacks!.activatePanel).toHaveBeenCalledBefore(panel.selectHostedTab);
    region.layout = activatePanel(region.layout, "browser");
    await region.updateComplete;
    shell.querySelector("wa-tab-group")!.dispatchEvent(
      new CustomEvent("wa-tab-show", {
        bubbles: true,
        detail: { name: "hosted:browser:native:page:2" },
      }),
    );
    expect(region.callbacks!.activatePanel).toHaveBeenCalledTimes(1);
    expect(panel.selectHostedTab).toHaveBeenCalledTimes(2);
  });

  it("closes pages through the owner and keeps the empty Browser slot open", async () => {
    const { shell, region, panel, changed } = await mount();
    shell.querySelector<HTMLButtonElement>('button[aria-label="Close tab: First page"]')!.click();
    expect(panel.closeHostedTab).toHaveBeenCalledExactlyOnceWith("remote:page:1");
    expect(region.callbacks!.closeSlot).not.toHaveBeenCalled();
    panel.hostedTabs = [];
    await changed();
    expect(labels(shell)).toEqual(["Review", "Browser", "Files"]);
    expect(region.layout.open).toBe(true);
    shell.querySelector<HTMLButtonElement>('button[aria-label="Close Browser"]')!.click();
    expect(region.callbacks!.closeSlot).toHaveBeenCalledExactlyOnceWith("browser");
  });

  it("closes the focused page on native Close and the panel only once no page remains", async () => {
    const { shell, region, panel, changed } = await mount();
    shell
      .querySelector('[data-region-header="side"]')!
      .dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
    const closePage = new CustomEvent("openclaw:native-close-focused-panel", { cancelable: true });
    window.dispatchEvent(closePage);
    expect(closePage.defaultPrevented).toBe(true);
    expect(panel.closeHostedTab).toHaveBeenCalledExactlyOnceWith("remote:page:1");
    expect(region.callbacks!.closeSlot).not.toHaveBeenCalled();

    panel.hostedTabs = [];
    await changed();
    const closePanel = new CustomEvent("openclaw:native-close-focused-panel", {
      cancelable: true,
    });
    window.dispatchEvent(closePanel);
    expect(closePanel.defaultPrevented).toBe(true);
    expect(panel.closeHostedTab).toHaveBeenCalledOnce();
    expect(region.callbacks!.closeSlot).toHaveBeenCalledExactlyOnceWith("browser");
  });

  it("falls back to Browser for an empty or not-yet-mounted owner", async () => {
    const { region, shell } = await mount({ tabs: [] });
    expect(labels(shell)).toEqual(["Review", "Browser", "Files"]);
    region.panelTemplates = {};
    await region.updateComplete;
    region.requestUpdate();
    await region.updateComplete;
    expect(labels(shell)).toEqual(["Review", "Browser", "Files"]);
  });

  it("updates labels and selection when the sibling panel emits its change event", async () => {
    const { panel, shell, changed } = await mount();
    panel.hostedTabs = [{ ...secondTab, label: "Renamed page" }];
    panel.activeHostedTabId = "native:page:2";
    await changed();
    expect(labels(shell)).toEqual(["Review", "Renamed page", "Files"]);
    expect(shell.querySelector("wa-tab[active]")?.getAttribute("panel")).toBe(
      "hosted:browser:native:page:2",
    );
  });

  it("renders a cached favicon after the hostname fetch settles", async () => {
    const fetchFavicon = vi.fn<LinkFaviconFetcher>().mockResolvedValue("blob:header-favicon");
    const { shell, region } = await mount({
      tabs: [{ ...firstTab, url: "https://favicon-ready.example/path" }],
      fetchFavicon,
    });
    await vi.waitFor(() =>
      expect(shell.querySelector("img.tabstrip-tab__favicon")?.getAttribute("src")).toBe(
        "blob:header-favicon",
      ),
    );
    expect(fetchFavicon).toHaveBeenCalledExactlyOnceWith(
      "favicon-ready.example",
      expect.any(AbortSignal),
    );
    region.requestUpdate();
    await region.updateComplete;
    expect(fetchFavicon).toHaveBeenCalledOnce();
  });

  it("keeps remote and native fallback icons when no favicon is available", async () => {
    const fetchFavicon = vi.fn<LinkFaviconFetcher>().mockResolvedValue(null);
    const { shell, region } = await mount({
      tabs: tabs.map(({ id, label, kind }) => ({
        id,
        label,
        kind,
        url: "https://favicon-missing.example/",
      })),
      fetchFavicon,
    });
    await vi.waitFor(() => expect(fetchFavicon).toHaveBeenCalledOnce());
    await region.updateComplete;
    expect(shell.querySelector("img.tabstrip-tab__favicon")).toBeNull();
    expect(
      shell.querySelector(
        'wa-tab[panel="hosted:browser:remote:page:1"] .tabstrip-tab__icon path[d="M2 12h20"]',
      ),
    ).not.toBeNull();
    expect(
      shell.querySelector(
        'wa-tab[panel="hosted:browser:native:page:2"] .tabstrip-tab__icon rect[width="20"][height="14"]',
      ),
    ).not.toBeNull();
  });

  it("never fetches blank, invalid, or hostless URLs", async () => {
    const fetchFavicon = vi.fn<LinkFaviconFetcher>();
    await mount({
      tabs: ["", "not a url", "about:blank"].map((url, index) => ({
        id: String(index),
        label: firstTab.label,
        kind: firstTab.kind,
        url,
      })),
      fetchFavicon,
    });
    expect(fetchFavicon).not.toHaveBeenCalled();
  });
});
