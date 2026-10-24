/* @vitest-environment jsdom */

import { createComponent } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import {
  PANEL_HOSTED_TABS_CHANGE_EVENT,
  type PanelHostedTab,
  type PanelHostedTabsElement,
} from "../../../components/panel-hosted-tabs.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { createSidebarRegionCallbackMocks } from "../../../test-helpers/sidebar-region-callbacks.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { sidebarPanelDefinitions } from "../chat-pane-embedded-panels.ts";
import { createMountedPanes } from "../chat-pane-mounted.test-support.ts";
import { getPaneTestRuntime } from "../chat-pane.test-support.ts";
import type { LinkFaviconFetcher } from "../link-favicon-cache.ts";
import { activatePanel, openSlot, closeSlot, type SidebarSlotId } from "../sidebar-layout.ts";
import "./chat-sidebar-region.runtime.tsx";

const shells: HTMLElement[] = [];
type TabIcon = "globe" | "monitor" | "terminal";
function makeTab(
  id: string,
  label: string,
  name: TabIcon,
  extra: Partial<PanelHostedTab> = {},
): PanelHostedTab {
  return {
    id,
    label,
    ...extra,
    get icon() {
      return createComponent(Icon, { name });
    },
  };
}
const firstTab = makeTab("remote:page:1", "First page", "globe", {
  url: "https://first.example/a",
});
const secondTab = makeTab("native:page:2", "Second page", "monitor", {
  url: "https://second.example/b",
});
const tabs = [firstTab, secondTab];
const div = (className = "") => Object.assign(document.createElement("div"), { className });

async function mount(
  options: {
    tabs?: PanelHostedTab[];
    fetchFavicon?: LinkFaviconFetcher;
    slot?: SidebarSlotId;
    wrapped?: boolean;
  } = {},
) {
  const slot = options.slot ?? "browser";
  const panel = Object.assign(document.createElement("div"), {
    hostedTabs: options.tabs ?? tabs,
    activeHostedTabId: "remote:page:1",
    selectHostedTab: vi.fn(),
    closeHostedTab: vi.fn().mockResolvedValue(undefined),
    handleToggleRequest: vi.fn(),
  }) satisfies PanelHostedTabsElement;
  const wrapped = options.wrapped !== false;
  if (wrapped) {
    panel.setAttribute("data-sidebar-panel-host", "");
  }
  const content = wrapped ? document.createElement("section") : panel;
  if (wrapped) {
    content.append(panel);
  }
  const region = document.createElement("openclaw-chat-sidebar-region");
  region.panelIdPrefix = `sidebar-region-fixture-${shells.length}`;
  region.layout = activatePanel(
    openSlot(openSlot(openSlot({ columns: [] }, "detail"), slot), "workspace"),
    slot,
  );
  region.panelDefinitions = sidebarPanelDefinitions().map((definition) =>
    Object.assign(definition, {
      content: definition.slot === slot ? content : null,
      panelHost: definition.slot === slot ? panel : undefined,
    }),
  );
  region.fetchFavicon = options.fetchFavicon;
  region.callbacks = createSidebarRegionCallbackMocks();
  const shell = div("sidebar-region"),
    outlet = div("sidebar-region__right-runtime");
  const header = div(),
    primary = div("sidebar-region__primary");
  region.elements = { shell, primary, header, outlet };
  shell.append(header, region, primary, outlet);
  document.body.append(shell);
  shells.push(shell);
  await region.updateComplete;
  const changed = async (hostedTabs = panel.hostedTabs) => {
    panel.hostedTabs = hostedTabs;
    panel.dispatchEvent(
      new CustomEvent(PANEL_HOSTED_TABS_CHANGE_EVENT, { bubbles: true, composed: true }),
    );
    await region.updateComplete;
  };
  await changed();
  const find = (selector: string) => shell.querySelector<HTMLElement>(selector)!;
  const page = (id: string) => find(`.tabstrip-tab[data-tab-value="hosted:${slot}:${id}"]`);
  const icon = (id: string, selector: string) =>
    page(id).querySelector(`.tabstrip-tab__icon ${selector}`);
  const layout = async (next: typeof region.layout) => {
    region.layout = next;
    await region.updateComplete;
  };
  return { panel, region, shell, changed, find, page, icon, layout };
}

function labels(shell: HTMLElement) {
  return [...shell.querySelectorAll(".tabstrip-tab .tabstrip-tab__label")].map(
    (label) => label.textContent,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const shell of shells.splice(0)) {
    shell.remove();
  }
});

it.each([true, false])("delivers panel commands with wrapped=%s", async (wrapped) => {
  const { panel, region, shell } = await mount({ wrapped });
  const container = shell.querySelector('[data-panel-slot="browser"]')!;
  const event = new CustomEvent("openclaw:browser-toggle", {
    detail: { open: true, newTab: true },
  });

  expect(container.firstElementChild === panel).toBe(!wrapped);
  expect(region.deliverPanelEvent("browser", event)).toBe(true);
  expect(panel.handleToggleRequest).toHaveBeenCalledExactlyOnceWith(event);
  expect(labels(shell)).toEqual(["Review", "First page", "Second page", "Files"]);
});

it("restores an expanded hosted panel only from its active page tab", async () => {
  const { region, page, layout } = await mount();
  await layout({ ...region.layout, expanded: true, expandedSide: true });
  page(firstTab.id).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(region.callbacks?.togglePanelExpanded).toHaveBeenCalledExactlyOnceWith("browser");
  page(secondTab.id).click();
  expect(region.callbacks?.togglePanelExpanded).toHaveBeenCalledTimes(1);
});

it("drags passive header chrome while keeping changing tabs and controls interactive", async () => {
  const postMessage = vi.fn();
  vi.stubGlobal("webkit", { messageHandlers: { openclawWindowDrag: { postMessage } } });
  const { panel, region, shell, changed, find } = await mount();
  region.panelDefinitions = region.panelDefinitions.map((definition) =>
    Object.assign(definition, {
      available: definition.slot === "browser" || definition.slot === "terminal",
    }),
  );
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
    await changed(pages);
    for (const selector of [".side-panel__header", ".side-panel__header-tabs"]) {
      expect(press(find(selector)).defaultPrevented).toBe(true);
      expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: "window-drag" });
    }
    for (const target of [
      ...shell.querySelectorAll(
        ".side-panel__header .tabstrip-tab, .side-panel__header .tabstrip-tab__label, .side-panel__header button, .side-panel__header button svg, .side-panel-type-menu__item, .side-panel-type-option__label",
      ),
      find('.side-panel-type-menu [role="menu"]'),
      panel,
    ]) {
      expect(press(target).defaultPrevented).toBe(false);
      expect(postMessage).not.toHaveBeenCalled();
    }
  }
});

it("activates the Browser panel before selecting a hosted id containing colons", async () => {
  const { region, panel, page, layout } = await mount();
  await layout(activatePanel(region.layout, "workspace"));
  page(secondTab.id).click();
  expect(region.callbacks!.activatePanel).toHaveBeenCalledExactlyOnceWith("browser");
  expect(panel.selectHostedTab).toHaveBeenCalledExactlyOnceWith("native:page:2");
  expect(region.callbacks!.activatePanel).toHaveBeenCalledBefore(panel.selectHostedTab);
  await layout(activatePanel(region.layout, "browser"));
  page(secondTab.id).click();
  expect(region.callbacks!.activatePanel).toHaveBeenCalledTimes(1);
  expect(panel.selectHostedTab).toHaveBeenCalledTimes(2);
});

it.each([false, true])("closes pages before the empty panel (native=%s)", async (native) => {
  const { shell, region, panel, changed, find } = await mount();
  const close = (label: string) => {
    if (!native) {
      find(`button[aria-label="${label}"]`).click();
      return;
    }
    const event = new CustomEvent("openclaw:native-close-focused-panel", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  };
  if (native) {
    find('[data-region-header="side"]').dispatchEvent(
      new Event("pointerdown", { bubbles: true, composed: true }),
    );
  }
  close("Close tab: First page");
  expect(panel.closeHostedTab).toHaveBeenCalledExactlyOnceWith("remote:page:1");
  expect(region.callbacks!.closeSlot).not.toHaveBeenCalled();
  await changed([]);
  expect(labels(shell)).toEqual(["Review", "Browser", "Files"]);
  expect(region.layout.open).toBe(true);
  close("Close Browser");
  expect(panel.closeHostedTab).toHaveBeenCalledOnce();
  expect(region.callbacks!.closeSlot).toHaveBeenCalledExactlyOnceWith("browser");
});

it.each(["native", "header"] as const)(
  "closes the desktop Files panel with its last hosted tab through %s Close",
  async (source) => {
    const { shell, region, panel, changed } = await mount({
      tabs: [firstTab],
      slot: "workspace",
    });
    region.presentation = "desktop";
    region.layout = openSlot({ columns: [] }, "workspace");
    region.callbacks!.closeSlot = vi.fn((slot) => {
      region.layout = closeSlot(region.layout, slot);
    });
    panel.closeHostedTab.mockImplementation(async () => {
      panel.hostedTabs = [];
      await changed();
    });
    await region.updateComplete;
    shell
      .querySelector('[data-region-header="side"]')!
      .dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
    if (source === "native") {
      const command = new CustomEvent("openclaw:native-close-focused-panel", {
        cancelable: true,
      });
      window.dispatchEvent(command);
      expect(command.defaultPrevented).toBe(true);
    } else {
      shell.querySelector<HTMLButtonElement>('button[aria-label="Close tab: First page"]')!.click();
    }
    await panel.closeHostedTab.mock.results[0]!.value;
    await region.updateComplete;
    await waitForSolid(() => {
      expect(region.callbacks!.closeSlot).toHaveBeenCalledExactlyOnceWith("workspace");
      expect(region.layout.open).toBe(false);
    });
  },
);

it.each([
  { sessionChanged: false, source: "native" },
  { sessionChanged: true, source: "native" },
  { sessionChanged: true, source: "header" },
])(
  "finishes mobile hosted Close only in its initiating session ($source, changed=$sessionChanged)",
  async ({ sessionChanged, source }) => {
    const { shell, region, panel, changed } = await mount({
      tabs: [firstTab],
      slot: "workspace",
    });
    const { pane, state } = createMountedPanes([]);
    getPaneTestRuntime(pane).mergedChrome = true;
    const mobileHost = () => pane.render().layout!.region.mobileHost!;
    mobileHost().navigate({ area: "panels" });
    region.mobileHost = mobileHost();
    region.presentation = "mobile";
    region.layout = openSlot({ columns: [] }, "workspace");
    region.callbacks!.closeSlot = vi.fn((slot) => {
      region.layout = closeSlot(region.layout, slot);
    });
    const closing = createDeferred();
    panel.closeHostedTab.mockImplementation(async () => {
      await closing.promise;
      panel.hostedTabs = [];
      await changed();
    });
    await region.updateComplete;
    shell
      .querySelector('[data-region-header="side"]')!
      .dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
    if (source === "native") {
      const command = new CustomEvent("openclaw:native-close-focused-panel", {
        cancelable: true,
      });
      window.dispatchEvent(command);
      expect(command.defaultPrevented).toBe(true);
    } else {
      shell.querySelector<HTMLButtonElement>('button[aria-label="Close tab: First page"]')!.click();
    }
    if (sessionChanged) {
      state.sessionKey = "agent:main:replacement";
      mobileHost().navigate({ area: "panels" });
      region.mobileHost = mobileHost();
      await region.updateComplete;
    }
    closing.resolve();
    await panel.closeHostedTab.mock.results[0]!.value;
    await region.updateComplete;
    expect(panel.closeHostedTab).toHaveBeenCalledExactlyOnceWith(firstTab.id);
    if (sessionChanged) {
      expect(mobileHost().open).toBe(true);
      expect(region.callbacks!.closeSlot).not.toHaveBeenCalled();
    } else {
      await waitForSolid(() => expect(mobileHost().open).toBe(false));
      expect(region.callbacks!.closeSlot).toHaveBeenCalledExactlyOnceWith("workspace");
    }
  },
);

it("presents non-browser hosted tabs with their title, status, badge and class", async () => {
  const { shell, page, icon } = await mount({
    slot: "terminal",
    tabs: [
      makeTab("shell:1", "zsh", "terminal", {
        title: "main: /workspace",
        statusLabel: "Exited (0)",
        badge: "agent",
        className: "is-exited",
      }),
    ],
  });
  expect(labels(shell)).toEqual(["Review", "zsh", "Files"]);
  const tab = page("shell:1");
  expect(tab.getAttribute("title")).toBe("main: /workspace");
  expect(tab.querySelector(".tabstrip-tab__status")?.textContent).toBe("Exited (0)");
  expect(tab.querySelector(".tabstrip-tab__badge")?.textContent).toBe("agent");
  expect(tab.classList.contains("is-exited")).toBe(true);
  expect(icon("shell:1", 'polyline[points="4 17 10 11 4 5"]')).not.toBeNull();
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
  const { shell, region, layout } = await mount({
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
  await layout({ ...region.layout });
  expect(fetchFavicon).toHaveBeenCalledOnce();
});

it("keeps remote and native fallback icons when no favicon is available", async () => {
  const fetchFavicon = vi.fn<LinkFaviconFetcher>().mockResolvedValue(null);
  const { shell, region, icon } = await mount({
    tabs: tabs.map((tab) => Object.assign({}, tab, { url: "https://favicon-missing.example/" })),
    fetchFavicon,
  });
  await vi.waitFor(() => expect(fetchFavicon).toHaveBeenCalledOnce());
  await region.updateComplete;
  expect(shell.querySelector("img.tabstrip-tab__favicon")).toBeNull();
  expect(icon(firstTab.id, 'path[d="M2 12h20"]')).not.toBeNull();
  expect(icon(secondTab.id, 'rect[width="20"][height="14"]')).not.toBeNull();
});

it("closes hosted resources sequentially while presenting close-all progress", async () => {
  const { panel, region, shell, changed } = await mount({ tabs: [firstTab] });
  const confirmation = createDeferred();
  const finishCloseAll = vi.fn(() => true);
  region.presentation = "desktop";
  region.callbacks!.closeSlot = vi.fn((slot) => {
    region.layout = closeSlot(region.layout, slot);
  });
  region.callbacks!.newTab = {
    open: vi.fn(),
    close: vi.fn(),
    openPanel: vi.fn(),
    finishCloseAll,
  };
  panel.closeHostedTab.mockImplementation(async () => {
    await confirmation.promise;
    await changed([]);
  });
  await region.updateComplete;
  shell.querySelector<HTMLButtonElement>('button[aria-label="Panel position"]')!.click();
  await vi.waitFor(() => expect(shell.querySelector('[data-value="close-all"]')).not.toBeNull());
  shell.querySelector<HTMLElement>('[data-value="close-all"]')!.click();
  await vi.waitFor(() => expect(panel.closeHostedTab).toHaveBeenCalledOnce());
  await vi.waitFor(() =>
    expect(shell.querySelector<HTMLButtonElement>('button[aria-label="New tab"]')!.disabled).toBe(
      true,
    ),
  );
  expect(finishCloseAll).not.toHaveBeenCalled();
  confirmation.resolve();
  await vi.waitFor(() => expect(finishCloseAll).toHaveBeenCalledOnce());
  expect(region.callbacks!.closeSlot).toHaveBeenCalledWith("browser");
});

it("retires close-all feedback on native scope replacement before a held close completes", async () => {
  const { panel, region, shell } = await mount({ tabs: [firstTab] });
  const confirmation = createDeferred();
  const finishCloseAll = vi.fn(() => true);
  region.presentation = "desktop";
  region.callbacks!.closeSlot = vi.fn((slot) => {
    region.layout = closeSlot(region.layout, slot);
  });
  region.callbacks!.newTab = {
    open: vi.fn(),
    close: vi.fn(),
    openPanel: vi.fn(),
    finishCloseAll,
  };
  panel.closeHostedTab.mockImplementation(() => confirmation.promise);
  await region.updateComplete;
  shell.querySelector<HTMLButtonElement>('button[aria-label="Panel position"]')!.click();
  await vi.waitFor(() => expect(shell.querySelector('[data-value="close-all"]')).not.toBeNull());
  shell.querySelector<HTMLElement>('[data-value="close-all"]')!.click();
  await vi.waitFor(() => expect(panel.closeHostedTab).toHaveBeenCalledOnce());
  await vi.waitFor(() =>
    expect(shell.querySelector<HTMLButtonElement>('button[aria-label="New tab"]')!.disabled).toBe(
      true,
    ),
  );
  region.panelIdPrefix = "replacement-scope";
  await region.updateComplete;
  await vi.waitFor(() =>
    expect(shell.querySelector<HTMLButtonElement>('button[aria-label="New tab"]')!.disabled).toBe(
      false,
    ),
  );
  expect(finishCloseAll).not.toHaveBeenCalled();
  confirmation.resolve();
  await panel.closeHostedTab.mock.results[0]!.value;
  await region.updateComplete;
  expect(finishCloseAll).not.toHaveBeenCalled();
});
