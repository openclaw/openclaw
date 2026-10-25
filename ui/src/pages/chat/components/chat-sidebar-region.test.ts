/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { GatewayBrowserClient } from "../../../api/gateway.ts";
import { createOverlay } from "../../../components/overlay-lifecycle.ts";
import { createControlUiPluginHost } from "../../../plugins/control-ui-host.ts";
import {
  ControlUiPluginRuntime,
  type ControlUiPluginOwner,
} from "../../../plugins/control-ui-runtime.ts";
import "../../../components/resizable-divider.ts";
import { sidebarPanelFixtureParams } from "../../../test-helpers/chat-pane-embedded-panels.ts";
import { createSidebarRegionCallbackMocks } from "../../../test-helpers/sidebar-region-callbacks.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { sidebarPanelDefinitions } from "../chat-pane-embedded-panels.ts";
import { createMountedPanes } from "../chat-pane-mounted.test-support.ts";
import { createInitializationContext, getPaneTestRuntime } from "../chat-pane.test-support.ts";
import { createPageState } from "../chat-state-page.ts";
import {
  activatePanel,
  openSlot,
  openSidebarNewTab,
  closeSidebarNewTab,
  closeSlot,
  promoteSidebarPanel,
  setSidebarOpen,
  setSidebarDock,
  setSidebarExpanded,
  SIDEBAR_GEOMETRY_COMMIT_EVENT,
  type SidebarLayout,
  type SidebarSlotId,
} from "../sidebar-layout.ts";
import type { SidebarPanelDefinition } from "./chat-sidebar-region-types.ts";
import "./chat-sidebar-region.runtime.tsx";

type Region = HTMLElementTagNameMap["openclaw-chat-sidebar-region"];

const regions: Region[] = [];

function element(markup: string): HTMLElement {
  const template = document.createElement("template");
  template.innerHTML = markup;
  return template.content.querySelector<HTMLElement>("*")!;
}

const div = (className: string, markup = "") =>
  Object.assign(document.createElement("div"), { className, innerHTML: markup });
const slots = (...names: SidebarSlotId[]) =>
  names.reduce<SidebarLayout>((layout, slot) => openSlot(layout, slot), { columns: [] });

async function createRegion(
  layout: SidebarLayout = openSlot({ columns: [] }, "detail"),
  definitions?: SidebarPanelDefinition[],
) {
  const shell = div("sidebar-region");
  const region = document.createElement("openclaw-chat-sidebar-region");
  region.panelIdPrefix = `sidebar-region-fixture-${regions.length}`;
  region.layout = layout;
  const content: Partial<Record<SidebarPanelDefinition["slot"], HTMLElement>> = {
    detail: element('<div data-panel="detail">Detail panel</div>'),
    terminal: element('<div data-panel="terminal">Terminal panel</div>'),
    workspace: element('<div data-panel="workspace">Workspace panel</div>'),
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
  region.callbacks = createSidebarRegionCallbackMocks();
  region.availableWidth = 1_200;
  const primary = div("sidebar-region__primary", "<main data-primary>Primary</main>");
  primary.dataset.region = "main";
  const rightRuntime = div("sidebar-region__right-runtime");
  const header = div("sidebar-region__header");
  region.elements = { shell, primary, header, outlet: rightRuntime };
  shell.append(header, region, primary, rightRuntime);
  document.body.append(shell);
  regions.push(region);
  await region.updateComplete;
  return region;
}

function root(region: Region): HTMLElement {
  return region.parentElement!;
}

function query(region: Region, selector: string): HTMLElement | null {
  return root(region).querySelector(selector);
}

async function update(region: Region, changes: Partial<Region>) {
  Object.assign(region, changes);
  await region.updateComplete;
}

async function openTypeMenu(region: Region) {
  root(region).querySelector<HTMLButtonElement>(".side-panel-type-menu__trigger")!.click();
  await waitForSolid(() =>
    expect(query(region, '[role="menu"]')?.matches(":popover-open")).toBe(true),
  );
}

async function mountPanel(
  region: Region,
  slot: SidebarPanelDefinition["slot"],
  content: HTMLElement,
  hosted = false,
) {
  await update(region, {
    panelDefinitions: region.panelDefinitions.map((definition) => ({
      ...definition,
      content: definition.slot === slot ? content : null,
      ...(hosted ? { panelHost: definition.slot === slot ? content : undefined } : {}),
    })),
  });
}

function nativeClose(claimed = true, detail?: { browserScope: string }) {
  const event = new CustomEvent("openclaw:native-close-focused-panel", {
    cancelable: true,
    detail,
  });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(claimed);
}

function pointerFocus(target: Element) {
  target.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
}

function fakeAnimationFrames() {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

function mobilePanelHost(region: Region) {
  const { pane } = createMountedPanes([]);
  getPaneTestRuntime(pane).mergedChrome = true;
  const host = () => pane.render().layout!.region.mobileHost!;
  host().navigate({ area: "panels" });
  Object.assign(region, { mobileHost: host(), presentation: "mobile" });
  return host;
}

afterEach(() => {
  for (const region of regions.splice(0)) {
    region.parentElement?.remove();
  }
});

describe("chat sidebar region", () => {
  it("preserves header focus when an already locked side panel refreshes", async () => {
    fakeAnimationFrames();
    const region = await createRegion();
    const header = element('<div class="sidebar-region__header"><button>Actions</button></div>');
    root(region).prepend(header);
    const actions = header.querySelector("button")!;
    actions.focus();
    region.sideFocusOrigin = () => actions;
    region.sideFocusLocked = true;
    await region.updateComplete;
    vi.advanceTimersToNextFrame();
    expect(document.activeElement).toBe(query(region, '.tabstrip-tab[aria-selected="true"]'));

    actions.focus();
    region.sideFocusOrigin = undefined;
    await update(region, { layout: { ...region.layout } });
    vi.advanceTimersToNextFrame();
    expect(document.activeElement).toBe(actions);
  });

  it("restores an expanded panel from its active tab unless focus is locked", async () => {
    const region = await createRegion({
      ...openSlot({ columns: [] }, "workspace"),
      expanded: true,
      expandedSide: true,
    });
    const tab = query(region, '.tabstrip-tab[data-tab-value="workspace"]')!;
    tab.click();
    expect(region.callbacks?.togglePanelExpanded).toHaveBeenCalledExactlyOnceWith("workspace");

    region.sideFocusLocked = true;
    await region.updateComplete;
    tab.click();
    expect(region.callbacks?.togglePanelExpanded).toHaveBeenCalledOnce();
  });

  it("updates the conversation tab identity without relabeling other panels or their controls", async () => {
    const layout = slots("dashboard", "workspace");
    const dashboard = layout.columns[0]!.panels.find((panel) => panel.slot === "dashboard")!;
    const region = await createRegion(promoteSidebarPanel(layout, dashboard.id));
    const tab = '.tabstrip-tab[data-tab-value="conversation"]';
    const label = () => query(region, `${tab} .tabstrip-tab__label`)?.textContent;
    expect(label()).toBe("Chat");

    const rename = (name: string, id: string, textAvatar: string) =>
      update(region, { conversationTab: { label: name, avatar: { id, textAvatar } } });
    await rename("Research assistant", "research-assistant", "🦉");
    expect(label()).toBe("Research assistant");
    const avatar = () =>
      query(region, `${tab} .identity-avatar__text`)?.getAttribute("data-avatar");
    expect(avatar()).toBe("🦉");
    expect(query(region, 'button[aria-label="Close Chat"]')).not.toBeNull();
    expect(
      [...root(region).querySelectorAll(".tabstrip-tab__label")].map((node) => node.textContent),
    ).toContain("Files");

    await rename("", "research-assistant", "🦉");
    expect(label()).toBe("Chat");
    expect(query(region, tab)?.querySelector("openclaw-tooltip")?.content).toBe("Chat");

    await rename("Planning assistant", "planning-assistant", "🦊");
    expect(label()).toBe("Planning assistant");
    expect(avatar()).toBe("🦊");
    await update(region, { conversationTab: undefined });
    expect(label()).toBe("Chat");
  });

  it("coalesces unchanged geometry and retires disconnected measurements", async () => {
    fakeAnimationFrames();
    const region = await createRegion();
    await update(region, { narrow: true });
    const shell = root(region);
    const commits: boolean[] = [];
    shell.addEventListener(SIDEBAR_GEOMETRY_COMMIT_EVENT, (event) => {
      commits.push((event as CustomEvent<{ widthChanged: boolean }>).detail.widthChanged);
    });
    vi.advanceTimersToNextFrame();
    commits.length = 0;

    for (let index = 0; index < 4; index++) {
      region.layout = { ...region.layout };
      await region.updateComplete;
    }
    expect(commits).toEqual([]);
    vi.advanceTimersToNextFrame();
    expect(commits).toEqual([false]);

    await update(region, { layout: { ...region.layout } });
    shell.remove();
    vi.advanceTimersToNextFrame();
    expect(commits).toEqual([false]);
  });

  it.each([false, true])(
    "claims native Close for the focused side tab and preserves its neighbor (mobile=%s)",
    async (mobile) => {
      const region = await createRegion(slots("workspace", "companion"));
      await mountPanel(
        region,
        "companion",
        element('<textarea aria-label="Side chat"></textarea>'),
      );
      const mobileHost = mobile ? mobilePanelHost(region) : undefined;
      region.callbacks!.closeSlot = (slot) => {
        region.layout = closeSlot(region.layout, slot);
      };
      await region.updateComplete;
      query(region, "textarea")!.focus();

      nativeClose();
      await region.updateComplete;
      expect(region.layout.columns[0]?.panels.map((panel) => panel.slot)).toEqual(["workspace"]);
      expect(region.layout.open).toBe(true);
      if (mobile) {
        expect(mobileHost!().open).toBe(true);
      }

      nativeClose();
      expect(region.layout.open).toBe(false);
      if (mobile) {
        await waitForSolid(() => expect(mobileHost!().open).toBe(false));
      }
    },
  );

  it("dismisses an empty mobile launcher after its own close navigation", async () => {
    const region = await createRegion(openSidebarNewTab({ columns: [] }));
    const mobileHost = mobilePanelHost(region);
    region.callbacks!.newTab = {
      open: vi.fn(),
      openPanel: vi.fn(),
      finishCloseAll: vi.fn(() => true),
      close: () => {
        region.layout = closeSidebarNewTab(region.layout);
        mobileHost().navigate({ area: "panels" });
        region.mobileHost = mobileHost();
      },
    };
    await region.updateComplete;
    pointerFocus(query(region, '[data-region-header="side"]')!);
    nativeClose();
    await waitForSolid(() => expect(mobileHost().open).toBe(false));
    expect(region.layout.newTab).toBeUndefined();
  });

  it("uses current main/side roles and closes through the conversation owner", async () => {
    const layout = promoteSidebarPanel(slots("conversation", "detail"), "detail");
    const region = await createRegion(layout);
    const main = query(region, '[data-panel-slot="detail"]')!;
    pointerFocus(main);
    nativeClose(false);
    const conversation = query(region, ".sidebar-region__primary")!;
    conversation.dataset.region = "side";
    pointerFocus(conversation);
    nativeClose();
    expect(region.callbacks!.closeSlot).toHaveBeenCalledExactlyOnceWith("conversation");
  });

  it("routes native Browser focus by its presentation scope, not stale page focus", async () => {
    const other = await createRegion();
    const region = await createRegion(openSlot({ columns: [] }, "browser"));
    const browser = element('<div data-native-browser-scope="native-owner"></div>');
    await mountPanel(region, "browser", browser, true);
    pointerFocus(query(other, "[data-panel-slot]")!);
    nativeClose(true, { browserScope: "native-owner" });
    expect(region.callbacks!.closeSlot).toHaveBeenCalledExactlyOnceWith("browser");
    expect(other.callbacks!.closeSlot).not.toHaveBeenCalled();
  });

  it("yields native Close while a registered dialog remains native-open", async () => {
    const region = await createRegion();
    const dialog = document.createElement("dialog");
    document.body.append(dialog);
    const overlay = createOverlay("sidebar-modal-fixture", undefined, {
      native: {
        isOpen: () => dialog.open,
        show: () => {
          dialog.open = true;
        },
        hide: () => {
          dialog.open = false;
        },
      },
    });
    overlay.bindSurface(dialog);
    onTestFinished(() => {
      overlay.dispose();
      dialog.remove();
    });
    pointerFocus(query(region, "[data-panel-slot]")!);
    dialog.open = true;
    nativeClose(false);
    expect(region.callbacks!.closeSlot).not.toHaveBeenCalled();

    dialog.open = false;
    nativeClose();
    expect(region.callbacks!.closeSlot).toHaveBeenCalledExactlyOnceWith("detail");
  });

  it.each(["hidden", "minimized", "disconnected", "main", "outside"] as const)(
    "does not claim native Close after %s loses side focus",
    async (state) => {
      const region = await createRegion();
      pointerFocus(query(region, "[data-panel-slot]")!);
      if (state === "hidden") {
        root(region).hidden = true;
      }
      if (state === "minimized") {
        region.layout = setSidebarOpen(region.layout, false);
      }
      if (state === "disconnected") {
        root(region).remove();
      }
      if (state === "main" || state === "outside") {
        pointerFocus(state === "main" ? query(region, "[data-primary]")! : document.body);
      }
      nativeClose(false);
      expect(region.callbacks!.closeSlot).not.toHaveBeenCalled();
    },
  );

  it("retains unavailable plugin tabs and recovers their registration", async () => {
    const slot = "plugin:fixture/notes";
    const layout = slots("workspace", slot);
    const saved = structuredClone(layout);
    const context = createInitializationContext();
    const state = createPageState(
      context,
      { afterCommit: () => () => {} },
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
        inlineViews: new Map(),
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
    const params = sidebarPanelFixtureParams(state, {
      paneId: "fixture",
      panePresentationId: "fixture-main",
      connected: false,
      workspace: undefined,
      isPluginPanelPresented: () => true,
    });
    const workspace = element('<div data-panel="workspace">Workspace panel</div>');
    const definitions = () =>
      sidebarPanelDefinitions(params).map((definition) =>
        definition.slot === "workspace"
          ? Object.assign(definition, { view: undefined, content: workspace })
          : definition,
      );
    const region = await createRegion(layout, definitions());
    const refresh = async () => {
      region.panelDefinitions = definitions();
      await region.updateComplete;
    };
    const unavailable = query(region, `[data-panel-slot="${slot}"] openclaw-panel-empty-state`);
    expect(unavailable?.textContent).toContain("The plugin that owns this tab is not active");
    expect(region.layout).toEqual(saved);
    root(region)
      .querySelector<HTMLButtonElement>('button[aria-label="Close fixture/notes"]')
      ?.click();
    expect(region.callbacks?.closeSlot).toHaveBeenCalledWith(slot);

    root(region)
      .querySelector<HTMLButtonElement>('.tabstrip-tab[data-tab-value="workspace"]')
      ?.click();
    expect(region.callbacks?.activatePanel).toHaveBeenCalledWith("workspace");
    await update(region, { layout: activatePanel(region.layout, "workspace") });
    expect(query(region, '[data-panel-slot="workspace"]')?.hasAttribute("hidden")).toBe(false);
    expect(query(region, '[data-panel="workspace"]')?.textContent).toBe("Workspace panel");

    params.pluginPanels = [entry];
    await refresh();
    expect(query(region, `[data-panel-slot="${slot}"] openclaw-plugin-view`)).not.toBeNull();
    expect(query(region, 'button[aria-label="Close Fixture notes"]')).not.toBeNull();
    expect(region.layout.columns[0]?.panels).toEqual(saved.columns[0]?.panels);
  });

  it("keeps Browser available in the plus menu to create another hosted tab", async () => {
    const slot = "browser";
    const handleToggleRequest = vi.fn();
    const region = await createRegion(openSlot({ columns: [] }, slot));
    const panel = Object.assign(element("<div>Panel content</div>"), { handleToggleRequest });
    await update(region, {
      panelDefinitions: region.panelDefinitions.map((definition) => ({
        ...definition,
        available: definition.slot === slot,
        label: "Updated browser",
      })),
    });
    await mountPanel(region, slot, panel, true);
    expect(query(region, ".side-panel-type-menu__trigger")?.getAttribute("aria-expanded")).toBe(
      "false",
    );
    await openTypeMenu(region);
    const menuItem = Array.from(
      root(region).querySelectorAll<HTMLButtonElement>(".side-panel-type-menu__item"),
    ).find((item) => Reflect.get(item, "value") === slot);

    expect(menuItem).toBeDefined();
    expect(menuItem?.textContent).toContain("Updated browser");
    menuItem!.click();

    await waitForSolid(() => expect(region.callbacks?.openSlot).toHaveBeenCalledWith(slot));
    expect(region.callbacks?.openSlot).toHaveBeenCalledBefore(handleToggleRequest);
    expect(handleToggleRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "openclaw:browser-toggle",
        detail: { open: true, newTab: true },
      }),
    );
  });

  it("opens into a type selector instead of restoring a previous tab", async () => {
    const region = await createRegion(setSidebarOpen({ columns: [], expanded: false }, true));
    const selector = query(region, ".side-panel-empty--selector");

    expect(
      selector?.querySelector(
        ".side-panel-empty__title, .side-panel-empty__description, :scope > .side-panel-empty__icon",
      ),
    ).toBeNull();
    root(region).querySelector<HTMLButtonElement>(".side-panel-empty__type")?.click();
    expect(region.callbacks?.openSlot).toHaveBeenCalledWith("detail");
  });

  it("keeps side tab dismissal separate from task toolbar actions", async () => {
    const region = await createRegion();
    expect(query(region, '[data-region-header="side"] .rail-header__actions')).toBeNull();
    root(region).querySelector<HTMLButtonElement>('button[aria-label="Close Review"]')!.click();
    expect(region.callbacks?.closeSlot).toHaveBeenCalledWith("detail");
    await update(region, {
      layout: setSidebarExpanded(promoteSidebarPanel(region.layout, "detail"), true),
    });
    expect(query(region, '[data-region-header="main"]')).toBeNull();
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
    const primary = query(region, ".sidebar-region__primary")!;
    const panel = query(region, '[data-region="side"]:not([hidden])')!;
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
    await update(region, { layout: setSidebarDock(region.layout, "left") });
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

  it("retains app input and terminal content while minimizing until their tabs close", async () => {
    const region = await createRegion(setSidebarOpen(slots("terminal", "dashboard"), false));
    region.panelDefinitions = region.panelDefinitions.map((definition) =>
      definition.slot === "dashboard"
        ? Object.assign({}, definition, {
            content: element('<input aria-label="Unsaved app input" />'),
          })
        : definition,
    );
    await region.updateComplete;
    expect(query(region, '[data-panel-slot="dashboard"]')).toBeNull();
    await update(region, { layout: setSidebarOpen(region.layout, true) });
    const input = root(region).querySelector<HTMLInputElement>("input")!;
    input.value = "Unsaved note";
    const terminal = query(region, '[data-panel="terminal"]')!;

    await update(region, { layout: setSidebarOpen(region.layout, false) });
    const panel = query(region, '[data-panel-slot="dashboard"]')!;
    expect(panel.hidden).toBe(true);
    expect(query(region, "resizable-divider")).toBeNull();
    expect(input.isConnected).toBe(true);
    expect(terminal.isConnected).toBe(true);
    expect(query(region, '[data-panel-slot="terminal"]')?.hidden).toBe(true);

    await update(region, { layout: setSidebarOpen(region.layout, true) });
    expect(query(region, "input")).toBe(input);
    expect(input.value).toBe("Unsaved note");
    expect(panel.hidden).toBe(false);
    expect(query(region, '[data-panel="terminal"]')).toBe(terminal);

    await update(region, { layout: closeSlot(region.layout, "dashboard") });
    expect(input.isConnected).toBe(false);
    expect(query(region, '[data-panel="terminal"]')).toBe(terminal);
    expect(query(region, '[data-panel-slot="terminal"]')?.hidden).toBe(false);
  });
});
