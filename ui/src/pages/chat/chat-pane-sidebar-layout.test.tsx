/* @vitest-environment jsdom */

import { Show, createSignal, type Setter } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSidebarRegionCallbackMocks as callbacks } from "../../test-helpers/sidebar-region-callbacks.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import { createMountedPanes } from "./chat-pane-mounted.test-support.ts";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import { resolveSidebarLayoutForBoard } from "./chat-pane-sidebar-layout.ts";
import { SidebarRegionView } from "./chat-pane-sidebar-view.tsx";
import { getPaneTestRuntime } from "./chat-pane.test-support.ts";
import "./components/chat-sidebar-region.runtime.tsx";
import {
  closeSlot,
  isSidebarSlotVisible,
  openSlot,
  promoteSidebarPanel,
  setSidebarDock,
  setSidebarExpanded,
  setSidebarOpen,
  sidebarActivePanel,
  sidebarMainPanel,
  type SidebarLayout,
} from "./sidebar-layout.ts";

function board(face: ResolvedBoardView["face"] = "dashboard") {
  return {
    available: true,
    hasBoard: true,
    face,
    provider: { hasLoadedSnapshot: true },
  } as ResolvedBoardView;
}

const containers: HTMLElement[] = [];
function createContainer() {
  const container = document.body.appendChild(document.createElement("div"));
  containers.push(container);
  return container;
}

function resolveBoard(layout: SidebarLayout = { columns: [] }, view = board(), paneWidth = 1_400) {
  return resolveSidebarLayoutForBoard({ board: view, layout, paneWidth });
}

async function settledRegion(container: HTMLElement) {
  await waitForSolid(() =>
    expect(container.querySelector("openclaw-chat-sidebar-region")).not.toBeNull(),
  );
  const region = container.querySelector("openclaw-chat-sidebar-region")!;
  await region.updateComplete;
  return region;
}

function DetailContent() {
  return (
    <aside data-detail>
      Details
      <input type="checkbox" />
    </aside>
  );
}

type RegionProps = Parameters<typeof SidebarRegionView>[0];
function Region(props: Pick<RegionProps, "layout" | "panelDefinitions"> & Partial<RegionProps>) {
  const defaultCallbacks = callbacks();
  const primary = <main>Conversation</main>;
  return (
    <SidebarRegionView
      panelIdPrefix="chat-panel-fixture"
      presentationId="fixture"
      availableWidth={1400}
      narrow={false}
      callbacks={defaultCallbacks}
      primary={primary}
      {...props}
    />
  );
}

function panels(slots: string[], detail = <DetailContent />, native = false) {
  return sidebarPanelDefinitions().map((definition) =>
    Object.assign(definition, {
      available: slots.includes(definition.slot),
      content:
        definition.slot === "detail" ? (
          detail
        ) : native ? (
          <div data-native-slot={definition.slot}>{definition.label}</div>
        ) : null,
    }),
  );
}

type LayoutState = {
  layout: SidebarLayout;
  narrow: boolean;
  presentationId: string;
  availableWidth: number;
};

const layouts = new Map<HTMLElement, Setter<LayoutState>>();

async function nativeCloseLayoutFixture() {
  const [layout, setLayout] = createSignal(
    openSlot(openSlot({ columns: [] }, "workspace"), "detail"),
  );
  const { container } = mountSolid(() => {
    const definitions = panels(
      ["detail", "workspace"],
      <textarea aria-label="Side panel input" />,
      true,
    );
    return (
      <Region
        callbacks={{
          ...callbacks(),
          closeSlot: (slot) => setLayout((current) => closeSlot(current, slot)),
        }}
        layout={layout()}
        panelDefinitions={definitions}
      />
    );
  });
  await settledRegion(container);
  return { container, layout };
}

async function renderLayout(
  container: HTMLElement,
  layout: SidebarLayout,
  narrow = false,
  presentationId = "sidebar-layout-fixture",
  availableWidth = narrow ? 620 : 1_400,
) {
  const next = { layout, narrow, presentationId, availableWidth };
  const update = layouts.get(container);
  if (update) {
    update(next);
  } else {
    mountSolid(
      () => {
        const [state, setState] = createSignal(next);
        layouts.set(container, setState);
        const definitions = panels(["detail", "terminal", "workspace"]);
        return (
          <Region
            panelIdPrefix={`chat-panel-${encodeURIComponent(state().presentationId)}`}
            presentationId={state().presentationId}
            availableWidth={state().availableWidth}
            layout={state().layout}
            narrow={state().narrow}
            panelDefinitions={definitions}
            primary={
              <main data-primary>
                Primary
                <textarea />
              </main>
            }
          />
        );
      },
      { container },
    );
  }
  flush();
  if (layout.columns.length) {
    await settledRegion(container);
  }
}

afterEach(() => {
  layouts.clear();
  for (const container of containers.splice(0)) {
    container.remove();
  }
});

describe("chat pane sidebar layout", () => {
  it.each(["surviving opener", "removed opener", "outside focus"] as const)(
    "restores side-panel focus with a %s",
    async (scenario) => {
      const layout = openSlot({ columns: [] }, "detail");
      let update!: Setter<{ locked: boolean; showOpener: boolean; open: boolean }>;
      const { container } = mountSolid(() => {
        const [state, setState] = createSignal({ locked: false, showOpener: true, open: true });
        update = setState;
        const definitions = panels(["detail"]);
        return (
          <>
            <button data-outside>Outside</button>
            <Region
              panelIdPrefix="chat-panel-focus-return"
              presentationId="focus-return"
              layout={setSidebarOpen(layout, state().open)}
              sideFocusLocked={state().locked}
              sideFocusManaged={true}
              panelDefinitions={definitions}
              header={
                <>
                  <Show when={state().showOpener}>
                    <button data-opener>Open panel</button>
                  </Show>
                  <button>Actions</button>
                </>
              }
            />
          </>
        );
      });
      containers.push(container);
      const region = await settledRegion(container);
      const opener = container.querySelector<HTMLButtonElement>("[data-opener]")!;
      opener.focus();
      update((state) => ({ ...state, locked: true }));
      flush();
      await region.updateComplete;
      container.querySelector<HTMLInputElement>("[data-detail] input")!.focus();
      if (scenario !== "surviving opener") {
        update((state) => ({ ...state, showOpener: false }));
        flush();
      }
      const outside = container.querySelector<HTMLButtonElement>("[data-outside]")!;
      if (scenario === "outside focus") {
        outside.focus();
      }
      update((state) => ({ ...state, locked: false, open: false }));
      flush();
      await region.updateComplete;
      expect(document.activeElement).toBe(
        scenario === "surviving opener"
          ? opener
          : scenario === "outside focus"
            ? outside
            : container.querySelector(".sidebar-region__header"),
      );
    },
  );

  it.each(["subagents", "processes"] as const)(
    "keeps the selected %s after the native launcher closes and the owner refreshes",
    async (slot) => {
      const { pane, state } = createMountedPanes([]);
      getPaneTestRuntime(pane).mergedChrome = false;
      state.updateSidebarLayout(openSlot({ columns: [] }, "workspace"));
      const [layout, setLayout] = createSignal(state.sidebarLayout);
      const mounted = mountSolid(() => {
        const definitions = panels(["workspace", "subagents", "processes"], undefined, true);
        const controls = () => {
          layout();
          return pane.render().layout!.region.callbacks;
        };
        return (
          <Region
            panelIdPrefix="chat-panel-launcher-intent"
            presentationId="launcher-intent"
            presentation="desktop"
            callbacks={controls()}
            layout={layout()}
            panelDefinitions={definitions}
          />
        );
      });
      const draw = async () => {
        setLayout(state.sidebarLayout);
        flush();
        await settledRegion(mounted.container);
      };
      await draw();
      const newTab = mounted.container.querySelector<HTMLButtonElement>(
        'button[aria-label="New tab"]',
      );
      expect(newTab).not.toBeNull();
      newTab!.click();
      await draw();
      const option = [
        ...mounted.container.querySelectorAll<HTMLButtonElement>(".side-panel-launcher button"),
      ].find(
        (button) =>
          button.querySelector(".side-panel-type-option__label")?.textContent ===
          (slot === "subagents" ? "Subagents" : "Processes"),
      );
      expect(option).toBeDefined();
      option!.click();
      // The user action must open the panel; a later owner update must not manufacture success.
      expect(isSidebarSlotVisible(state.sidebarLayout, slot)).toBe(true);
      await draw();
      expect(mounted.container.querySelector(".side-panel-launcher")).toBeNull();
      const content = mounted.container.querySelector('[data-native-slot="' + slot + '"]');
      expect(content).not.toBeNull();
      expect(content!.closest("[data-region]")?.hasAttribute("hidden")).toBe(false);

      state.updateSidebarLayout({ ...state.sidebarLayout });
      await draw();
      expect(isSidebarSlotVisible(state.sidebarLayout, slot)).toBe(true);
      expect(mounted.container.querySelector('[data-native-slot="' + slot + '"]')).toBe(content);
    },
  );

  it("keeps native content and the parent layout writable when the DOM provider changes", async () => {
    // SAFETY: the region transports application context; this fixture's panel reads no capabilities.
    const container = createApplicationContextProvider({} as ApplicationContext);
    containers.push(container);
    document.body.append(container);
    const layout = openSlot({ columns: [] }, "detail");
    await renderLayout(container, layout);
    const region = container.querySelector("openclaw-chat-sidebar-region")!;
    const primary = container.querySelector("[data-primary]");
    const detail = container.querySelector("[data-detail]")!;
    const checkbox = detail.querySelector("input")!;
    checkbox.checked = true;

    // Native JSX content stays with its parent Solid owner when the DOM provider changes.
    container.setContext({} as ApplicationContext);
    await region.updateComplete;
    expect(container.querySelector("[data-detail]")).toBe(detail);
    expect(checkbox.checked).toBe(true);

    await renderLayout(container, promoteSidebarPanel(layout, "detail"));
    expect(container.querySelector("[data-primary]")).toBe(primary);
    expect(
      container
        .querySelector("[data-detail]")
        ?.closest("[data-region]")
        ?.getAttribute("data-region"),
    ).toBe("main");
  });

  it("keeps tab targets within split and retained conversation presentations", async () => {
    const layout = openSlot({ columns: [] }, "detail");
    const presentations = [
      ["left", "session-a"],
      ["right", "session-a"],
      ["left", "session-b"],
    ];
    const targetIds: string[] = [];
    const tabIds: string[] = [];
    for (const presentation of presentations) {
      const container = createContainer();
      const presentationId = JSON.stringify(presentation);
      await renderLayout(container, layout, false, presentationId);
      const detail = container.querySelector("[data-detail]")!;
      const primary = container.querySelector("[data-primary]")!;
      for (const next of [layout, promoteSidebarPanel(layout, "detail"), layout]) {
        await renderLayout(container, next, false, presentationId);
        const tab = container.querySelector(".tabstrip-tab[active]")!;
        const targetId = tab.getAttribute("aria-controls")!;
        const target = document.getElementById(targetId);
        const chatSelected = tab.getAttribute("data-tab-value") === "conversation";
        expect(target).toBe((chatSelected ? primary : detail).closest("[data-region]"));
        expect(target?.getAttribute("role")).toBe("region");
        expect(target?.getAttribute("aria-label")).toBe(chatSelected ? "Chat" : "Review");
        expect(target?.contains(chatSelected ? detail : primary)).toBe(false);
        expect(container.querySelector("[data-primary]")).toBe(primary);
        expect(container.querySelector("[data-detail]")).toBe(detail);
        if (next !== layout) {
          targetIds.push(targetId);
          tabIds.push(tab.id);
        }
      }
    }
    expect(new Set(targetIds).size).toBe(presentations.length);
    expect(new Set(tabIds).size).toBe(presentations.length);
  });

  it("restores focus to the surviving tab after its parent commits native Close", async () => {
    const { container: parent, layout } = await nativeCloseLayoutFixture();
    containers.push(parent);
    flush();
    const region = parent.querySelector("openclaw-chat-sidebar-region")!;
    await region.updateComplete;
    parent.querySelector("textarea")!.focus();

    const command = new CustomEvent("openclaw:native-close-focused-panel", { cancelable: true });
    window.dispatchEvent(command);
    expect(command.defaultPrevented).toBe(true);
    flush();
    await region.updateComplete;

    expect(sidebarActivePanel(layout())?.slot).toBe("workspace");
    const nextTab = parent.querySelector<HTMLElement>('.tabstrip-tab[data-tab-value="workspace"]')!;
    expect(nextTab).not.toBeNull();
    expect(document.activeElement).toBe(nextTab);
  });

  it("preserves drafts and panel state across swapping, docking, focus, minimize, and mobile", async () => {
    const container = createContainer();
    const open = openSlot({ columns: [] }, "detail");

    await renderLayout(container, { columns: [], open: false });
    const primary = container.querySelector("[data-primary]");
    const draft = primary!.querySelector("textarea")!;
    draft.value = "Keep this draft";
    await renderLayout(container, open);
    const detail = container.querySelector<HTMLElement>("[data-detail]")!;
    const checkbox = detail.querySelector("input")!;
    checkbox.checked = true;
    expect(container.querySelector("[data-primary]")).toBe(primary);
    await renderLayout(container, setSidebarDock(open, "bottom"));
    expect(container.querySelector(".sidebar-region--bottom")).not.toBeNull();
    expect(container.querySelector('[data-panel-slot="detail"]')?.getAttribute("data-region")).toBe(
      "side",
    );
    expect(container.querySelector("resizable-divider")?.orientation).toBe("horizontal");
    const promoted = promoteSidebarPanel(open, "detail");
    for (const dock of ["left", "right", "bottom"] as const) {
      await renderLayout(container, setSidebarDock(promoted, dock));
      expect(detail.closest("[data-region]")?.getAttribute("data-region")).toBe("main");
      expect(primary?.closest("[data-region]")?.getAttribute("data-region")).toBe("side");
      expect(primary?.closest("[data-region]")?.hasAttribute("hidden")).toBe(false);
      expect(container.querySelector("[data-detail]")).toBe(detail);
      expect(container.querySelector("[data-primary]")).toBe(primary);
    }
    await renderLayout(container, setSidebarExpanded(promoted, true));
    expect(primary?.closest("[data-region]")?.hasAttribute("hidden")).toBe(true);
    expect(detail.closest("[data-region]")?.hasAttribute("hidden")).toBe(false);
    await renderLayout(container, setSidebarOpen(promoted, false));
    expect(primary?.closest("[data-region]")?.hasAttribute("hidden")).toBe(true);
    await renderLayout(container, setSidebarOpen(promoted, true), true);
    expect(primary?.closest("[data-region]")?.hasAttribute("hidden")).toBe(false);
    expect(container.querySelector(".sidebar-region--narrow")).not.toBeNull();
    const conversation = promoted.columns[0]!.panels.find(
      (panel) => panel.slot === "conversation",
    )!;
    await renderLayout(container, promoteSidebarPanel(promoted, conversation.id));
    expect(primary?.closest("[data-region]")?.getAttribute("data-region")).toBe("main");
    expect(container.querySelector("[data-detail]")).toBe(detail);
    expect(container.querySelector("[data-primary]")).toBe(primary);
    expect(draft.value).toBe("Keep this draft");
    expect(checkbox.checked).toBe(true);
  });

  it("keeps an unmeasured shell in the wide layout", async () => {
    const container = createContainer();
    await renderLayout(
      container,
      openSlot({ columns: [] }, "detail"),
      false,
      "sidebar-layout-fixture",
      0,
    );
    expect(container.querySelector(".sidebar-region--narrow")).toBeNull();
  });

  it("opens a dashboard route in the canonical right side panel without reopening a closed panel", () => {
    const layout = resolveBoard();
    expect(layout).toMatchObject({
      open: true,
      columns: [{ side: "right", panels: [{ slot: "dashboard" }] }],
    });
    expect(layout.columns).toHaveLength(1);
    expect(resolveBoard({ ...layout, open: false })).toEqual({ ...layout, open: false });
  });

  it.each([
    [
      "saved bottom dock",
      { ...openSlot({ columns: [] }, "terminal"), dock: "bottom" },
      "dashboard",
    ],
    ["closed browser", { ...openSlot({ columns: [] }, "browser"), open: false }, "dashboard"],
    [
      "selected companion",
      openSlot(openSlot({ columns: [] }, "dashboard"), "companion"),
      "dashboard",
    ],
    ["dashboard on chat", { ...openSlot({ columns: [] }, "dashboard"), open: false }, "chat"],
  ] as const)("preserves %s", (_name, layout, face) => {
    expect(resolveBoard(layout, board(face))).toEqual(layout);
  });

  it("routes container expansion and docking without changing the selected tab", () => {
    const { pane, state } = createMountedPanes([]);
    getPaneTestRuntime(pane).mergedChrome = false;
    state.updateSidebarLayout(openSlot({ columns: [] }, "detail"));
    const selectedPanel = state.sidebarLayout.columns[0]?.activePanelId;
    const controls = () => pane.render().layout!.region.callbacks;

    controls().togglePanelExpanded();
    expect(state.sidebarLayout).toMatchObject({
      open: true,
      expanded: true,
      expandedSide: true,
    });
    expect(state.sidebarLayout.columns[0]?.activePanelId).toBe(selectedPanel);
    controls().setDock("bottom");
    expect(state.sidebarLayout.dock).toBe("bottom");
    expect(state.sidebarLayout.columns[0]?.activePanelId).toBe(selectedPanel);
  });

  it("keeps an empty dashboard open and only removes it when dashboard support is unavailable", () => {
    const layout = promoteSidebarPanel(
      openSlot(openSlot({ columns: [] }, "dashboard"), "detail"),
      "dashboard",
    );
    const loading = { ...board(), hasBoard: false };
    expect(resolveBoard(layout, loading)).toEqual(layout);
    const removed = resolveBoard(layout, { ...loading, available: false });
    expect(sidebarMainPanel(removed)?.slot).toBe("conversation");
    expect(sidebarActivePanel(removed)?.slot).toBe("detail");
  });

  it("fits only the one canonical panel width", () => {
    const layout = resolveBoard(
      openSlot(openSlot({ columns: [] }, "detail"), "discussion"),
      board("chat"),
      1_000,
    );
    expect(layout.columns).toHaveLength(1);
    expect(layout.columns[0]?.width).toBe(480);
  });
});
