/* @vitest-environment jsdom */

import { html, type TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { icons } from "../../../components/icons.ts";
import {
  PANEL_HOSTED_TABS_CHANGE_EVENT,
  type PanelHostedTab,
  type PanelHostedTabsElement,
} from "../../../components/panel-hosted-tabs.ts";
import type { LinkFaviconFetcher } from "../link-favicon-loader.ts";
import { activatePanel, openSlot, type SidebarSlotId } from "../sidebar-layout.ts";
import "./chat-sidebar-region.runtime.ts";

const shells: HTMLElement[] = [];
const firstTab: PanelHostedTab = {
  id: "remote:page:1",
  label: "First page",
  url: "https://first.example/a",
  icon: icons.globe,
};
const secondTab: PanelHostedTab = {
  id: "native:page:2",
  label: "Second page",
  url: "https://second.example/b",
  icon: icons.monitor,
};
const tabs = [firstTab, secondTab];

async function mount(
  options: {
    tabs?: PanelHostedTab[];
    fetchFavicon?: LinkFaviconFetcher;
    slot?: SidebarSlotId;
    hostedActions?: TemplateResult;
  } = {},
) {
  const slot = options.slot ?? "browser";
  const panel = Object.assign(document.createElement("div"), {
    hostedTabs: options.tabs ?? tabs,
    hostedActions: options.hostedActions,
    activeHostedTabId: "remote:page:1",
    selectHostedTab: vi.fn(),
    closeHostedTab: vi.fn().mockResolvedValue(undefined),
  }) satisfies PanelHostedTabsElement;
  const region = document.createElement("openclaw-chat-sidebar-region");
  region.layout = activatePanel(
    openSlot(openSlot(openSlot({ columns: [] }, "detail"), slot), "workspace"),
    slot,
  );
  region.panelTemplates = { [slot]: html`${panel}` };
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
  vi.unstubAllGlobals();
  for (const shell of shells.splice(0)) {
    shell.remove();
  }
});

describe("chat sidebar hosted tabs", () => {
  it("drags passive header chrome while keeping changing tabs and controls interactive", async () => {
    const postMessage = vi.fn();
    vi.stubGlobal("webkit", { messageHandlers: { openclawWindowDrag: { postMessage } } });
    const { panel, region, shell, changed } = await mount();
    region.availableSlots = ["browser", "terminal"];
    const press = (target: Element) => {
      postMessage.mockClear();
      const event = new MouseEvent("mousedown", {
        bubbles: true,
        composed: true,
        cancelable: true,
        button: 0,
      });
      target.dispatchEvent(event);
      return event;
    };

    for (const pages of [[firstTab], tabs, [secondTab], []]) {
      panel.hostedTabs = pages;
      await changed();
      for (const selector of [".side-panel__header", ".side-panel__header-tabs"]) {
        expect(press(shell.querySelector(selector)!).defaultPrevented).toBe(true);
        expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: "window-drag" });
      }
      for (const target of shell.querySelectorAll(
        ".side-panel__header wa-tab, .side-panel__header .tabstrip-tab__label, .side-panel__header button, .side-panel__header button svg, .side-panel-type-menu__item, .side-panel-type-option__label",
      )) {
        expect(press(target).defaultPrevented).toBe(false);
        expect(postMessage).not.toHaveBeenCalled();
      }
      const menu = shell.querySelector("wa-dropdown")!.shadowRoot!.querySelector('[role="menu"]')!;
      expect(press(menu).defaultPrevented).toBe(false);
      expect(postMessage).not.toHaveBeenCalled();
      expect(press(panel).defaultPrevented).toBe(false);
      expect(postMessage).not.toHaveBeenCalled();
    }
  });

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

  it("presents non-browser hosted tabs with their title, status, badge and class", async () => {
    const { shell } = await mount({
      slot: "terminal",
      tabs: [
        {
          id: "shell:1",
          label: "zsh",
          title: "main: /workspace",
          statusLabel: "Exited (0)",
          badge: "agent",
          className: "is-exited",
          icon: icons.terminal,
        },
      ],
    });
    expect(labels(shell)).toEqual(["Review", "zsh", "Files"]);
    const tab = shell.querySelector('wa-tab[panel="hosted:terminal:shell:1"]')!;
    expect(tab.getAttribute("title")).toBe("main: /workspace");
    expect(tab.querySelector(".tabstrip-tab__status")?.textContent).toBe("Exited (0)");
    expect(tab.querySelector(".tabstrip-tab__badge")?.textContent).toBe("agent");
    expect(tab.classList.contains("is-exited")).toBe(true);
    expect(
      tab.querySelector('.tabstrip-tab__icon polyline[points="4 17 10 11 4 5"]'),
    ).not.toBeNull();
  });

  it("renders hosted actions before slot actions only while their panel is active", async () => {
    const { region, shell } = await mount({
      slot: "terminal",
      hostedActions: html`<button type="button">New session</button>`,
    });
    region.panelActions = {
      terminal: html`<button type="button">Terminal action</button>`,
      workspace: html`<button type="button">Files action</button>`,
    };
    await region.updateComplete;
    const actionLabels = () =>
      [...shell.querySelectorAll(".side-panel__action-group--content button")].map(
        (button) => button.textContent,
      );
    expect(actionLabels()).toEqual(["New session", "Terminal action"]);

    region.layout = activatePanel(region.layout, "workspace");
    await region.updateComplete;
    expect(actionLabels()).toEqual(["Files action"]);
    expect(shell.querySelector("[data-panel-slot='terminal']")?.hasAttribute("hidden")).toBe(true);

    region.layout = activatePanel(region.layout, "terminal");
    await region.updateComplete;
    expect(actionLabels()).toEqual(["New session", "Terminal action"]);
  });

  it("prefers an explicit favicon over the hostname fetch and fallback icon", async () => {
    const favicon = "data:image/png;base64,eA==";
    const fetchFavicon = vi.fn<LinkFaviconFetcher>().mockResolvedValue(null);
    const { shell } = await mount({ tabs: [{ ...secondTab, favicon }], fetchFavicon });
    const icon = shell.querySelector(".tabstrip-tab__favicon");
    expect(icon?.getAttribute("src")).toBe(favicon);
    expect(icon?.getAttribute("alt")).toBe("");
    expect(icon?.parentElement?.querySelector("svg")).toBeNull();
    expect(fetchFavicon).not.toHaveBeenCalled();
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
      tabs: tabs.map(({ id, label, icon }) => ({
        id,
        label,
        icon,
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
      tabs: [undefined, "", "not a url", "about:blank"].map((url, index) => ({
        id: String(index),
        label: firstTab.label,
        icon: firstTab.icon,
        url,
      })),
      fetchFavicon,
    });
    expect(fetchFavicon).not.toHaveBeenCalled();
  });
});
