/* @vitest-environment jsdom */

import { html, nothing, type TemplateResult } from "lit";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { GatewayBrowserClient } from "../../../api/gateway.ts";
import "../../../components/resizable-divider.ts";
import { createControlUiPluginHost } from "../../../plugins/control-ui-host.ts";
import {
  ControlUiPluginRuntime,
  type ControlUiPluginOwner,
} from "../../../plugins/control-ui-runtime.ts";
import { sidebarPanelDefinitions } from "../chat-pane-embedded-panels.ts";
import { createInitializationContext } from "../chat-pane.test-support.ts";
import { createPageState } from "../chat-state-page.ts";
import {
  activatePanel,
  openSlot,
  closeSlot,
  promoteSidebarPanel,
  setSidebarOpen,
  setSidebarDock,
  setSidebarExpanded,
  SIDEBAR_GEOMETRY_COMMIT_EVENT,
  type SidebarLayout,
} from "../sidebar-layout.ts";
import type { SidebarPanelDefinition } from "./chat-sidebar-region-types.ts";
import "./chat-sidebar-region.runtime.ts";

type Region = HTMLElementTagNameMap["openclaw-chat-sidebar-region"] & {
  updateComplete: Promise<unknown>;
};

const regions: Region[] = [];

async function createRegion(
  layout: SidebarLayout = openSlot({ columns: [] }, "detail"),
  definitions?: SidebarPanelDefinition[],
) {
  const shell = document.createElement("div");
  shell.className = "sidebar-region";
  const region = document.createElement("openclaw-chat-sidebar-region") as Region;
  region.panelIdPrefix = `sidebar-region-fixture-${regions.length}`;
  region.layout = layout;
  const content: Partial<Record<SidebarPanelDefinition["slot"], TemplateResult>> = {
    detail: html`<div data-panel="detail">Detail panel</div>`,
    terminal: html`<div data-panel="terminal">Terminal panel</div>`,
    workspace: html`<div data-panel="workspace">Workspace panel</div>`,
  };
  region.panelDefinitions =
    definitions ??
    sidebarPanelDefinitions().map((definition) =>
      Object.assign(definition, {
        available: ["detail", "terminal", "workspace", "companion", "dashboard"].includes(
          definition.slot,
        ),
        content: content[definition.slot] ?? null,
      }),
    );
  region.callbacks = {
    activatePanel: vi.fn(),
    togglePanelExpanded: vi.fn(),
    closeSlot: vi.fn(),
    openSlot: vi.fn(),
    reorderPanel: vi.fn(),
    resizePanel: vi.fn(),
    setOpen: vi.fn(),
  };
  region.availableWidth = 1_200;
  const primary = document.createElement("div");
  primary.className = "sidebar-region__primary";
  primary.dataset.region = "main";
  primary.innerHTML = "<main data-primary>Primary</main>";
  const rightRuntime = document.createElement("div");
  rightRuntime.className = "sidebar-region__right-runtime";
  shell.append(region, primary, rightRuntime);
  document.body.append(shell);
  regions.push(region);
  await region.updateComplete;
  return region;
}

function root(region: Region): HTMLElement {
  return region.parentElement!;
}

afterEach(() => {
  for (const region of regions.splice(0)) {
    region.parentElement?.remove();
  }
});

describe("chat sidebar region", () => {
  it("updates the conversation tab identity without relabeling other panels or their controls", async () => {
    const layout = openSlot(openSlot({ columns: [] }, "dashboard"), "workspace");
    const dashboard = layout.columns[0]!.panels.find((panel) => panel.slot === "dashboard")!;
    const region = await createRegion(promoteSidebarPanel(layout, dashboard.id));
    const label = () =>
      root(region).querySelector('wa-tab[panel="conversation"] .tabstrip-tab__label');
    expect(label()?.textContent).toBe("Chat");

    region.conversationTab = {
      label: "Research assistant",
      icon: html`<span data-agent-avatar>🦉</span>`,
    };
    await region.updateComplete;
    expect(label()?.textContent).toBe("Research assistant");
    expect(
      root(region).querySelector('wa-tab[panel="conversation"] [data-agent-avatar]'),
    ).not.toBeNull();
    expect(root(region).querySelector('button[aria-label="Close Chat"]')).not.toBeNull();
    expect(
      [...root(region).querySelectorAll(".tabstrip-tab__label")].map((tab) => tab.textContent),
    ).toContain("Files");

    region.conversationTab = { label: "", icon: html`` };
    await region.updateComplete;
    expect(label()?.textContent).toBe("Chat");
    expect(
      root(region).querySelector('wa-tab[panel="conversation"]')?.querySelector("openclaw-tooltip")
        ?.content,
    ).toBe("Chat");

    region.conversationTab = {
      label: "Planning assistant",
      icon: html`<span data-agent-avatar>🦊</span>`,
    };
    await region.updateComplete;
    expect(label()?.textContent).toBe("Planning assistant");
    expect(root(region).querySelector("[data-agent-avatar]")?.textContent).toBe("🦊");
    region.conversationTab = undefined;
    await region.updateComplete;
    expect(label()?.textContent).toBe("Chat");
  });

  it("coalesces committed geometry and retires disconnected measurements", async () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const region = await createRegion();
    region.narrow = true;
    await region.updateComplete;
    const shell = root(region);
    const primary = shell.querySelector<HTMLElement>(".sidebar-region__primary")!;
    const panel = shell.querySelector<HTMLElement>(".side-panel__panel")!;
    let mainWidth = 800;
    let sideWidth = 400;
    const measure = vi
      .spyOn(primary, "getBoundingClientRect")
      .mockImplementation(() => new DOMRect(0, 0, mainWidth, 600));
    vi.spyOn(panel, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, 0, sideWidth, 600),
    );
    const commits: boolean[] = [];
    shell.addEventListener(SIDEBAR_GEOMETRY_COMMIT_EVENT, (event) => {
      commits.push((event as CustomEvent<{ widthChanged: boolean }>).detail.widthChanged);
    });
    vi.advanceTimersToNextFrame();
    measure.mockClear();
    commits.length = 0;

    for (let index = 0; index < 4; index++) {
      region.requestUpdate();
      await region.updateComplete;
    }
    expect(measure).not.toHaveBeenCalled();
    expect(commits).toEqual([]);
    vi.advanceTimersToNextFrame();
    expect(measure).toHaveBeenCalledTimes(1);
    expect(commits).toEqual([false]);

    // Swapping content can keep the total width while changing each transcript.
    mainWidth = 400;
    sideWidth = 800;
    region.requestUpdate();
    await region.updateComplete;
    vi.advanceTimersToNextFrame();
    expect(commits).toEqual([false, true]);

    measure.mockClear();
    region.requestUpdate();
    await region.updateComplete;
    shell.remove();
    vi.advanceTimersToNextFrame();
    expect(measure).not.toHaveBeenCalled();
  });

  it("claims native Close for the focused side tab and preserves its neighbor", async () => {
    const region = await createRegion(
      openSlot(openSlot({ columns: [] }, "workspace"), "companion"),
    );
    region.panelDefinitions = region.panelDefinitions.map((definition) => ({
      ...definition,
      content:
        definition.slot === "companion" ? html`<textarea aria-label="Side chat"></textarea>` : null,
    }));
    region.callbacks!.closeSlot = (slot) => {
      region.layout = closeSlot(region.layout, slot);
    };
    await region.updateComplete;
    root(region).querySelector("textarea")!.focus();

    const command = new CustomEvent("openclaw:native-close-focused-panel", { cancelable: true });
    window.dispatchEvent(command);
    expect(command.defaultPrevented).toBe(true);
    await region.updateComplete;
    expect(region.layout.columns[0]?.panels.map((panel) => panel.slot)).toEqual(["workspace"]);
    expect(region.layout.open).toBe(true);

    const nextCommand = new CustomEvent("openclaw:native-close-focused-panel", {
      cancelable: true,
    });
    window.dispatchEvent(nextCommand);
    expect(nextCommand.defaultPrevented).toBe(true);
    expect(region.layout.open).toBe(false);
  });

  it("yields native Close after pointer focus moves from Side chat to main or outside", async () => {
    const region = await createRegion();
    const side = root(region).querySelector<HTMLElement>('[data-panel-slot="detail"]')!;
    side.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
    const main = root(region).querySelector<HTMLElement>("[data-primary]")!;
    main.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
    const mainCommand = new CustomEvent("openclaw:native-close-focused-panel", {
      cancelable: true,
    });
    window.dispatchEvent(mainCommand);
    expect(mainCommand.defaultPrevented).toBe(false);
    side.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
    const outsideCommand = new CustomEvent("openclaw:native-close-focused-panel", {
      cancelable: true,
    });
    window.dispatchEvent(outsideCommand);
    expect(outsideCommand.defaultPrevented).toBe(false);
    expect(region.callbacks!.closeSlot).not.toHaveBeenCalled();
  });

  it("uses current main/side roles and closes through the conversation owner", async () => {
    const layout = promoteSidebarPanel(
      openSlot(openSlot({ columns: [] }, "conversation"), "detail"),
      "detail",
    );
    const region = await createRegion(layout);
    const main = root(region).querySelector<HTMLElement>('[data-panel-slot="detail"]')!;
    main.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
    const mainCommand = new CustomEvent("openclaw:native-close-focused-panel", {
      cancelable: true,
    });
    window.dispatchEvent(mainCommand);
    expect(mainCommand.defaultPrevented).toBe(false);
    const conversation = root(region).querySelector<HTMLElement>(".sidebar-region__primary")!;
    conversation.dataset.region = "side";
    conversation.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
    const command = new CustomEvent("openclaw:native-close-focused-panel", { cancelable: true });
    window.dispatchEvent(command);
    expect(command.defaultPrevented).toBe(true);
    expect(region.callbacks!.closeSlot).toHaveBeenCalledExactlyOnceWith("conversation");
  });

  it("routes native Browser focus by its presentation scope, not stale page focus", async () => {
    const other = await createRegion();
    const region = await createRegion(openSlot({ columns: [] }, "browser"));
    region.panelDefinitions = region.panelDefinitions.map((definition) => ({
      ...definition,
      content:
        definition.slot === "browser"
          ? html`<div data-native-browser-scope="native-owner"></div>`
          : null,
    }));
    await region.updateComplete;
    root(other)
      .querySelector("[data-panel-slot]")!
      .dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
    const command = new CustomEvent("openclaw:native-close-focused-panel", {
      cancelable: true,
      detail: { browserScope: "native-owner" },
    });
    window.dispatchEvent(command);
    expect(command.defaultPrevented).toBe(true);
    expect(region.callbacks!.closeSlot).toHaveBeenCalledExactlyOnceWith("browser");
    expect(other.callbacks!.closeSlot).not.toHaveBeenCalled();
  });

  it.each(["hidden", "minimized", "disconnected"] as const)(
    "does not claim native Close from a %s retained panel",
    async (state) => {
      const region = await createRegion();
      root(region)
        .querySelector("[data-panel-slot]")!
        .dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
      if (state === "hidden") {
        root(region).hidden = true;
      }
      if (state === "minimized") {
        region.layout = setSidebarOpen(region.layout, false);
      }
      if (state === "disconnected") {
        root(region).remove();
      }
      const command = new CustomEvent("openclaw:native-close-focused-panel", { cancelable: true });
      window.dispatchEvent(command);
      expect(command.defaultPrevented).toBe(false);
      expect(region.callbacks!.closeSlot).not.toHaveBeenCalled();
    },
  );

  it("retains unavailable plugin tabs and recovers their registration", async () => {
    const slot = "plugin:fixture/notes";
    const layout = openSlot(openSlot({ columns: [] }, "workspace"), slot);
    const saved = structuredClone(layout);
    const context = createInitializationContext();
    const state = createPageState(
      context,
      { afterCommit: () => () => {}, invalidate: vi.fn() },
      document.createElement("div"),
    );
    state.sessionKey = "agent:main:main";
    state.sidebarLayout = layout;
    const runtime = new ControlUiPluginRuntime(() => context);
    const owner: Omit<ControlUiPluginOwner, "host"> = {
      descriptor: {
        pluginId: "fixture",
        name: "Fixture",
        revision: "one",
        entryUrl: "/__openclaw__/plugins/control-ui/fixture/one/index.js",
        styles: [],
      },
      client: new GatewayBrowserClient({ url: "ws://fixture.invalid" }),
      abort: new AbortController(),
      disposers: new Set(),
      contributions: {
        pages: new Map(),
        navigation: new Map(),
        panels: new Map(),
        actions: new Map(),
        replacements: new Map(),
        accessories: new Map(),
        widgets: new Map(),
      },
      selections: new Map(),
    };
    onTestFinished(() => {
      owner.abort.abort();
      owner.client.stop();
      runtime.dispose();
    });
    const entry: NonNullable<
      Parameters<typeof sidebarPanelDefinitions>[0]
    >["pluginPanels"][number] = {
      key: "fixture/notes",
      pluginId: "fixture",
      value: { id: "notes", label: "Fixture notes", mount: () => undefined },
      host: createControlUiPluginHost(() => context, runtime, owner),
      signal: owner.abort.signal,
    };
    const params: NonNullable<Parameters<typeof sidebarPanelDefinitions>[0]> = {
      state,
      paneId: "fixture",
      panePresentationId: "fixture-main",
      subagentsInputRegion: "page",
      subagentsPresented: false,
      subagentsAvailable: false,
      onSubagentSessionSelect: vi.fn(),
      themeMode: "dark",
      agentId: "main",
      browserPresented: false,
      browserTabsInHeader: true,
      terminalTabsInHeader: true,
      companionPresented: false,
      companionFocusRequest: undefined,
      browserRefreshOnPresentation: false,
      desktopPresented: false,
      desktopRefreshOnPresentation: false,
      desktopAvailable: false,
      desktopSource: null,
      desktopFocusHref: "",
      onDesktopFocusTargetChange: vi.fn(),
      dashboard: nothing,
      workspace: html`<div data-panel="workspace">Workspace panel</div>`,
      renderDetail: () => html``,
      digest: null,
      activeRunId: null,
      pullRequests: [],
      companion: {
        turns: [],
        loading: false,
        draft: "",
      },
      onCompanionSubmit: vi.fn(),
      onCompanionDraftChange: vi.fn(),
      connected: false,
      onClearCompanion: vi.fn(),
      discussion: null,
      discussionAvailable: false,
      discussionOpenUrl: null,
      discussionSourceGeneration: 0,
      pluginPanels: [],
      isPluginPanelPresented: () => true,
    };
    const region = await createRegion(layout, sidebarPanelDefinitions(params));
    params.pluginPanels = [];
    const refresh = async () => {
      region.panelDefinitions = sidebarPanelDefinitions(params);
      await region.updateComplete;
    };
    await refresh();

    const unavailable = root(region).querySelector(
      `[data-panel-slot="${slot}"] openclaw-panel-empty-state`,
    );
    await (unavailable as HTMLElement & { updateComplete?: Promise<unknown> })?.updateComplete;
    expect(unavailable?.textContent).toContain("The plugin that owns this tab is not active");
    expect(region.panelDefinitions.find((definition) => definition.slot === slot)?.available).toBe(
      false,
    );
    expect(region.layout).toEqual(saved);
    root(region)
      .querySelector<HTMLButtonElement>('button[aria-label="Close fixture/notes"]')
      ?.click();
    expect(region.callbacks?.closeSlot).toHaveBeenCalledWith(slot);

    root(region)
      .querySelector('wa-tab[panel="workspace"]')
      ?.dispatchEvent(
        new CustomEvent("wa-tab-show", { bubbles: true, detail: { name: "workspace" } }),
      );
    expect(region.callbacks?.activatePanel).toHaveBeenCalledWith("workspace");
    region.layout = activatePanel(region.layout, "workspace");
    await region.updateComplete;
    expect(
      root(region).querySelector('[data-panel-slot="workspace"]')?.hasAttribute("hidden"),
    ).toBe(false);
    expect(root(region).querySelector('[data-panel="workspace"]')?.textContent).toBe(
      "Workspace panel",
    );

    params.pluginPanels = [entry];
    await refresh();
    expect(region.panelDefinitions.find((definition) => definition.slot === slot)?.available).toBe(
      true,
    );
    expect(
      root(region).querySelector(`[data-panel-slot="${slot}"] openclaw-plugin-view`),
    ).not.toBeNull();
    expect(root(region).querySelector('button[aria-label="Close Fixture notes"]')).not.toBeNull();
    expect(region.layout.columns[0]?.panels).toEqual(saved.columns[0]?.panels);
  });

  it.each([
    { slot: "browser", eventType: "openclaw:browser-toggle", detail: { open: true, newTab: true } },
  ] as const)(
    "keeps $slot available in the plus menu to create another hosted tab",
    async ({ slot, eventType, detail }) => {
      const handleToggleRequest = vi.fn();
      const region = await createRegion(openSlot({ columns: [] }, slot));
      region.panelDefinitions = region.panelDefinitions.map((definition) => ({
        ...definition,
        available: definition.slot === slot,
        content:
          definition.slot === slot
            ? html`<div .handleToggleRequest=${handleToggleRequest}>Panel content</div>`
            : null,
      }));
      await region.updateComplete;
      const menuItem = Array.from(
        root(region).querySelectorAll<HTMLElement>("wa-dropdown-item"),
      ).find((item) => Reflect.get(item, "value") === slot);

      expect(menuItem).toBeDefined();
      root(region)
        .querySelector(".side-panel-type-menu")
        ?.dispatchEvent(
          new CustomEvent("wa-select", { bubbles: true, detail: { item: { value: slot } } }),
        );

      expect(region.callbacks?.openSlot).toHaveBeenCalledWith(slot);
      expect(region.callbacks?.openSlot).toHaveBeenCalledBefore(handleToggleRequest);
      expect(handleToggleRequest).toHaveBeenCalledWith(
        expect.objectContaining({ type: eventType, detail }),
      );
    },
  );

  it("opens into a type selector instead of restoring a previous tab", async () => {
    const region = await createRegion(setSidebarOpen({ columns: [], expanded: false }, true));
    const selector = root(region).querySelector(".side-panel-empty--selector");

    expect(selector?.querySelector(".side-panel-empty__title")).toBeNull();
    expect(selector?.querySelector(".side-panel-empty__description")).toBeNull();
    expect(selector?.querySelector(":scope > .side-panel-empty__icon")).toBeNull();
    expect(
      Array.from(selector?.querySelectorAll(".side-panel-empty__type") ?? [], (item) =>
        item.textContent?.replace(/\s+/gu, " ").trim(),
      ),
    ).toEqual([
      "Review Ctrl+Alt+Shift+E",
      "Terminal Ctrl+`",
      "Files Ctrl+Shift+B",
      "Side chat Ctrl+Shift+S",
      "Dashboard Ctrl+Alt+Shift+G",
    ]);
    root(region).querySelector<HTMLButtonElement>(".side-panel-empty__type")?.click();
    expect(region.callbacks?.openSlot).toHaveBeenCalledWith("detail");

    const dashboard = Array.from(
      root(region).querySelectorAll<HTMLButtonElement>(".side-panel-empty__type"),
    ).find(
      (button) =>
        button.querySelector(".side-panel-type-option__label")?.textContent === "Dashboard",
    );
    dashboard?.click();
    expect(region.callbacks?.openSlot).toHaveBeenCalledWith("dashboard");
  });

  it("offers every chat-side content owner through the shared type menu", async () => {
    const region = await createRegion();
    region.panelDefinitions = region.panelDefinitions.map((definition) => ({
      ...definition,
      available: [
        "detail",
        "terminal",
        "browser",
        "workspace",
        "companion",
        "desktop",
        "discussion",
        "dashboard",
      ].includes(definition.slot),
    }));
    await region.updateComplete;

    expect(
      Array.from(root(region).querySelectorAll(".side-panel-type-menu__item"), (item) =>
        item.textContent?.replace(/\s+/gu, " ").trim(),
      ),
    ).toEqual([
      "Terminal Ctrl+`",
      "Browser Ctrl+Alt+Shift+U",
      "Files Ctrl+Shift+B",
      "Side chat Ctrl+Shift+S",
      "Desktop Ctrl+Alt+Shift+D",
      "Discussion Ctrl+Alt+Shift+J",
      "Dashboard Ctrl+Alt+Shift+G",
    ]);

    const browserMenuItem = Array.from(
      root(region).querySelectorAll<HTMLElement>(".side-panel-type-menu__item"),
    ).find((item) => Reflect.get(item, "value") === "browser");
    expect(browserMenuItem?.querySelector('path[d="M2 12h20"]')).not.toBeNull();

    region.layout = openSlot({ columns: [] }, "browser");
    await region.updateComplete;
    expect(root(region).querySelector('.tabstrip-tab__icon path[d="M2 12h20"]')).not.toBeNull();

    region.layout = { columns: [], open: true };
    await region.updateComplete;
    const browserEmptyItem = Array.from(
      root(region).querySelectorAll<HTMLElement>(".side-panel-empty__type"),
    ).find(
      (item) => item.querySelector(".side-panel-type-option__label")?.textContent === "Browser",
    );
    expect(browserEmptyItem?.querySelector('path[d="M2 12h20"]')).not.toBeNull();
  });

  it("keeps side tab dismissal separate from task toolbar actions", async () => {
    const region = await createRegion();
    expect(
      root(region).querySelector('[data-region-header="side"] .rail-header__actions'),
    ).toBeNull();
    root(region).querySelector<HTMLButtonElement>('button[aria-label="Close Review"]')!.click();
    expect(region.callbacks?.closeSlot).toHaveBeenCalledWith("detail");
    region.layout = setSidebarExpanded(promoteSidebarPanel(region.layout, "detail"), true);
    await region.updateComplete;
    expect(root(region).querySelector('[data-region-header="main"]')).toBeNull();
    expect(
      Array.from(root(region).querySelectorAll(".tabstrip-tab__label"), (node) =>
        node.textContent?.trim(),
      ),
    ).toEqual(["Chat"]);
  });

  it("docks and resizes the same panel across left, right, and bottom layouts", async () => {
    const region = await createRegion(
      setSidebarDock(openSlot({ columns: [] }, "detail"), "bottom"),
    );
    const primary = root(region).querySelector<HTMLElement>(".sidebar-region__primary")!;
    const panel = root(region).querySelector<HTMLElement>('[data-region="side"]:not([hidden])')!;
    const divider = root(region).querySelector<HTMLElement & { orientation: string }>(
      "resizable-divider",
    )!;
    primary.getBoundingClientRect = () => ({ height: 440 }) as DOMRect;
    panel.getBoundingClientRect = () => ({ height: 360 }) as DOMRect;
    root(region).getBoundingClientRect = () => ({ height: 800 }) as DOMRect;

    expect(divider.orientation).toBe("horizontal");
    divider.dispatchEvent(
      new CustomEvent("resize", { bubbles: true, detail: { splitRatio: 0.5 } }),
    );
    expect(region.callbacks?.resizePanel).toHaveBeenCalledWith(region.layout.columns[0]!.id, 400);
    region.layout = setSidebarDock(region.layout, "left");
    await region.updateComplete;
    primary.getBoundingClientRect = () => ({ width: 800 }) as DOMRect;
    panel.getBoundingClientRect = () => ({ width: 400 }) as DOMRect;
    const leftDivider = root(region).querySelector<HTMLElement & { orientation: string }>(
      "resizable-divider",
    )!;
    expect(leftDivider.orientation).toBe("vertical");
    leftDivider.dispatchEvent(
      new CustomEvent("resize", { bubbles: true, detail: { splitRatio: 0.25 } }),
    );
    expect(region.callbacks?.resizePanel).toHaveBeenLastCalledWith(
      region.layout.columns[0]!.id,
      300,
    );
  });

  it("retains hidden side content and visible main content when the side panel is minimized", async () => {
    const layout = promoteSidebarPanel(
      openSlot(openSlot({ columns: [] }, "detail"), "terminal"),
      "detail",
    );
    const region = await createRegion(setSidebarOpen(layout, false));
    expect(root(region).querySelector('[data-panel-slot="terminal"]')?.hasAttribute("hidden")).toBe(
      true,
    );
    expect(root(region).querySelector('[data-panel="terminal"]')).not.toBeNull();
    expect(root(region).querySelector('[data-panel-slot="detail"]')?.hasAttribute("hidden")).toBe(
      false,
    );
    expect(root(region).querySelector("resizable-divider")).toBeNull();
    expect(root(region).querySelector('[data-region-header="main"]')).toBeNull();
    expect(root(region).querySelector("[data-primary]")).not.toBeNull();
  });

  it("retains app input and terminal content while minimizing until their tabs close", async () => {
    const region = await createRegion(
      setSidebarOpen(openSlot(openSlot({ columns: [] }, "terminal"), "dashboard"), false),
    );
    region.panelDefinitions = region.panelDefinitions.map((definition) =>
      definition.slot === "dashboard"
        ? { ...definition, content: html`<input aria-label="Unsaved app input" />` }
        : definition,
    );
    await region.updateComplete;
    expect(root(region).querySelector('[data-panel-slot="dashboard"]')).toBeNull();
    region.layout = setSidebarOpen(region.layout, true);
    await region.updateComplete;
    const input = root(region).querySelector<HTMLInputElement>("input")!;
    input.value = "Unsaved note";
    const terminal = root(region).querySelector('[data-panel="terminal"]')!;

    region.layout = setSidebarOpen(region.layout, false);
    await region.updateComplete;
    const panel = root(region).querySelector<HTMLElement>('[data-panel-slot="dashboard"]')!;
    expect(panel.hidden).toBe(true);
    expect(root(region).querySelector("resizable-divider")).toBeNull();
    expect(input.isConnected).toBe(true);
    expect(terminal.isConnected).toBe(true);
    expect(root(region).querySelector<HTMLElement>('[data-panel-slot="terminal"]')?.hidden).toBe(
      true,
    );

    region.layout = setSidebarOpen(region.layout, true);
    await region.updateComplete;
    expect(root(region).querySelector("input")).toBe(input);
    expect(input.value).toBe("Unsaved note");
    expect(panel.hidden).toBe(false);
    expect(root(region).querySelector('[data-panel="terminal"]')).toBe(terminal);

    region.layout = closeSlot(region.layout, "dashboard");
    await region.updateComplete;
    expect(input.isConnected).toBe(false);
    expect(root(region).querySelector('[data-panel="terminal"]')).toBe(terminal);
    expect(root(region).querySelector<HTMLElement>('[data-panel-slot="terminal"]')?.hidden).toBe(
      false,
    );
  });
});
