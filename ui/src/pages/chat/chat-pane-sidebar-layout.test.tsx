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

function DetailContent() {
  return (
    <aside data-detail>
      Details
      <input type="checkbox" />
    </aside>
  );
}

function CloseDetailContent() {
  return <textarea aria-label="Side panel input" />;
}

function WorkspaceContent() {
  return <div>Workspace</div>;
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
    const panelDefinitions = sidebarPanelDefinitions().map((definition) =>
      Object.assign(definition, {
        available: definition.slot === "detail" || definition.slot === "workspace",
        content:
          definition.slot === "detail" ? (
            <CloseDetailContent />
          ) : definition.slot === "workspace" ? (
            <WorkspaceContent />
          ) : null,
      }),
    );
    return (
      <SidebarRegionView
        panelIdPrefix="chat-panel-sidebar-layout-fixture"
        presentationId="sidebar-layout-fixture"
        availableWidth={1_400}
        callbacks={{
          ...callbacks(),
          closeSlot: (slot) => setLayout((current) => closeSlot(current, slot)),
        }}
        layout={layout()}
        narrow={false}
        panelDefinitions={panelDefinitions}
        primary={<main>Conversation</main>}
      />
    );
  });
  await waitForSolid(() =>
    expect(container.querySelector("openclaw-chat-sidebar-region")).not.toBeNull(),
  );
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
        const panelDefinitions = sidebarPanelDefinitions().map((definition) =>
          Object.assign(definition, {
            available: ["detail", "terminal", "workspace"].includes(definition.slot),
            content: definition.slot === "detail" ? <DetailContent /> : null,
          }),
        );
        return (
          <SidebarRegionView
            panelIdPrefix={`chat-panel-${encodeURIComponent(state().presentationId)}`}
            presentationId={state().presentationId}
            availableWidth={state().availableWidth}
            callbacks={callbacks()}
            layout={state().layout}
            narrow={state().narrow}
            panelDefinitions={panelDefinitions}
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
    await waitForSolid(() =>
      expect(container.querySelector("openclaw-chat-sidebar-region")).not.toBeNull(),
    );
    await container.querySelector("openclaw-chat-sidebar-region")!.updateComplete;
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
        return (
          <>
            <button data-outside>Outside</button>
            <SidebarRegionView
              panelIdPrefix="chat-panel-focus-return"
              presentationId="focus-return"
              availableWidth={1_400}
              callbacks={callbacks()}
              layout={setSidebarOpen(layout, state().open)}
              narrow={false}
              sideFocusLocked={state().locked}
              sideFocusManaged={true}
              panelDefinitions={sidebarPanelDefinitions().map((definition) =>
                Object.assign(definition, {
                  available: definition.slot === "detail",
                  content: definition.slot === "detail" ? <DetailContent /> : null,
                }),
              )}
              header={
                <>
                  <Show when={state().showOpener}>
                    <button data-opener>Open panel</button>
                  </Show>
                  <button>Actions</button>
                </>
              }
              primary={<main>Conversation</main>}
            />
          </>
        );
      });
      containers.push(container);
      await waitForSolid(() =>
        expect(container.querySelector("openclaw-chat-sidebar-region")).not.toBeNull(),
      );
      const region = container.querySelector("openclaw-chat-sidebar-region")!;
      await region.updateComplete;
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
        const definitions = sidebarPanelDefinitions().map((definition) =>
          Object.assign(definition, {
            available: ["workspace", "subagents", "processes"].includes(definition.slot),
            content: <div data-native-slot={definition.slot}>{definition.label}</div>,
          }),
        );
        const controls = () => {
          layout();
          return pane.render().layout!.region.callbacks;
        };
        return (
          <SidebarRegionView
            panelIdPrefix="chat-panel-launcher-intent"
            presentationId="launcher-intent"
            presentation="desktop"
            availableWidth={1400}
            callbacks={controls()}
            layout={layout()}
            narrow={false}
            panelDefinitions={definitions}
            primary={<main>Conversation</main>}
          />
        );
      });
      const draw = async () => {
        setLayout(state.sidebarLayout);
        flush();
        await waitForSolid(() =>
          expect(mounted.container.querySelector("openclaw-chat-sidebar-region")).not.toBeNull(),
        );
        await mounted.container.querySelector("openclaw-chat-sidebar-region")!.updateComplete;
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
      const container = document.createElement("div");
      containers.push(container);
      document.body.append(container);
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
    const container = document.createElement("div");
    document.body.append(container);
    containers.push(container);
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
    const container = document.createElement("div");
    containers.push(container);
    await renderLayout(
      container,
      openSlot({ columns: [] }, "detail"),
      false,
      "sidebar-layout-fixture",
      0,
    );
    expect(container.querySelector(".sidebar-region--narrow")).toBeNull();
  });

  it("places the unified panel below the conversation when bottom-docked", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    containers.push(container);
    const layout = { ...openSlot({ columns: [] }, "detail"), dock: "bottom" as const };

    await renderLayout(container, layout);

    expect(container.querySelector(".sidebar-region--bottom")).not.toBeNull();
    expect(container.querySelector('[data-panel-slot="detail"]')?.getAttribute("data-region")).toBe(
      "side",
    );
    expect(container.querySelector("resizable-divider")?.orientation).toBe("horizontal");
  });

  it("opens a dashboard route in the canonical right side panel", () => {
    const layout = resolveSidebarLayoutForBoard({
      board: board(),
      layout: { columns: [] },
      paneWidth: 1_400,
    });
    expect(layout.columns).toHaveLength(1);
    expect(layout.columns[0]?.side).toBe("right");
    expect(layout.columns[0]?.panels[0]?.slot).toBe("dashboard");
    expect(layout.open).toBe(true);
  });

  it("preserves a saved bottom dock and panel selection on a dashboard route", () => {
    const layout = resolveSidebarLayoutForBoard({
      board: board(),
      layout: { ...openSlot({ columns: [] }, "terminal"), dock: "bottom" },
      paneWidth: 1_400,
    });

    expect(layout.dock).toBe("bottom");
    expect(layout.columns[0]?.panels.map((panel) => panel.slot)).toEqual(["terminal"]);
  });

  it("does not reopen a dashboard panel the user explicitly closed", () => {
    const layout = resolveSidebarLayoutForBoard({
      board: board(),
      layout: { columns: [] },
      paneWidth: 1_400,
    });
    const closedDashboard = resolveSidebarLayoutForBoard({
      board: board(),
      layout: { ...layout, open: false },
      paneWidth: 1_400,
    });
    expect(closedDashboard.columns[0]?.panels.map((panel) => panel.slot)).toEqual(["dashboard"]);
    expect(closedDashboard.open).toBe(false);

    const closed = resolveSidebarLayoutForBoard({
      board: board(),
      layout: { ...openSlot({ columns: [] }, "browser"), open: false },
      paneWidth: 1_400,
    });
    expect(closed.columns[0]?.panels.map((panel) => panel.slot)).toEqual(["browser"]);
    expect(closed.open).toBe(false);
  });

  it("does not reactivate the dashboard over the selected side-panel tab", () => {
    const selectedSidePanel = openSlot(openSlot({ columns: [] }, "dashboard"), "companion");

    const layout = resolveSidebarLayoutForBoard({
      board: board(),
      layout: selectedSidePanel,
      paneWidth: 1_400,
    });

    expect(layout.columns[0]?.panels.map((panel) => panel.slot)).toEqual([
      "dashboard",
      "companion",
    ]);
    expect(layout.columns[0]?.activePanelId).toBe("companion");
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
    const awaitingSnapshot = resolveSidebarLayoutForBoard({
      board: { ...loading, provider: { hasLoadedSnapshot: false } } as ResolvedBoardView,
      layout,
      paneWidth: 1_400,
    });
    expect(awaitingSnapshot).toEqual(layout);
    expect(resolveSidebarLayoutForBoard({ board: loading, layout, paneWidth: 1_400 })).toEqual(
      layout,
    );
    const removed = resolveSidebarLayoutForBoard({
      board: { ...loading, available: false },
      layout,
      paneWidth: 1_400,
    });
    expect(sidebarMainPanel(removed)?.slot).toBe("conversation");
    expect(sidebarActivePanel(removed)?.slot).toBe("detail");
  });

  it("preserves dashboard panel state on the owning chat route", () => {
    for (const open of [true, false]) {
      const dashboardOnly = resolveSidebarLayoutForBoard({
        board: board("chat"),
        layout: { ...openSlot({ columns: [] }, "dashboard"), open },
        paneWidth: 1_400,
      });
      expect(dashboardOnly.columns[0]?.panels.map((panel) => panel.slot)).toEqual(["dashboard"]);
      expect(dashboardOnly.open).toBe(open);

      const withDetail = resolveSidebarLayoutForBoard({
        board: board("chat"),
        layout: { ...openSlot(openSlot({ columns: [] }, "dashboard"), "detail"), open },
        paneWidth: 1_400,
      });
      expect(withDetail.columns[0]?.panels.map((panel) => panel.slot)).toEqual([
        "dashboard",
        "detail",
      ]);
      expect(withDetail.open).toBe(open);
    }
  });

  it("fits only the one canonical panel width", () => {
    const layout = resolveSidebarLayoutForBoard({
      board: board("chat"),
      layout: openSlot(openSlot({ columns: [] }, "detail"), "discussion"),
      paneWidth: 1_000,
    });
    expect(layout.columns).toHaveLength(1);
    expect(layout.columns[0]?.width).toBe(480);
  });
});
