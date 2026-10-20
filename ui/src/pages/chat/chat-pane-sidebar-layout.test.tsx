/* @vitest-environment jsdom */

import { Show } from "solid-js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import {
  mountState,
  SidebarFixture,
  sidebarCallbacks,
} from "./chat-pane-sidebar-fixture.test-support.tsx";
import {
  resolveSidebarLayoutForBoard,
  sidebarRegionCallbacks,
} from "./chat-pane-sidebar-layout.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import "./components/chat-sidebar-region.runtime.tsx";
import {
  closeSlot,
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

function DetailContent() {
  return (
    <aside data-detail>
      <input type="checkbox" />
      <textarea aria-label="Side panel input" />
    </aside>
  );
}

function boardLayout(layout: SidebarLayout, resolvedBoard = board()) {
  return resolveSidebarLayoutForBoard({ board: resolvedBoard, layout, paneWidth: 1_400 });
}

function callbackFixture(layout: SidebarLayout, stored = layout) {
  const state = {
    sidebarLayout: stored,
    updateSidebarLayout: vi.fn(),
    updateSidebarActivePanel: vi.fn(),
  } as unknown as ChatPageHost;
  const params = {
    state,
    layout,
    closePanelSlot: vi.fn(),
    openPanelSlot: vi.fn(),
    forgetDiscussionUrl: vi.fn(),
    resizePanel: vi.fn(),
    setPanelOpen: vi.fn(),
  };
  return { ...params, callbacks: sidebarRegionCallbacks(params) };
}

type LayoutState = { layout: SidebarLayout; narrow: boolean; availableWidth: number };
type LayoutOptions = { container?: HTMLElement; presentationId?: string; width?: number };
function definitions(slots = ["detail", "terminal", "workspace"]) {
  return sidebarPanelDefinitions().map((definition) =>
    Object.assign(definition, {
      available: slots.includes(definition.slot),
      content: definition.slot === "detail" ? <DetailContent /> : null,
    }),
  );
}

async function layoutFixture(layout: SidebarLayout, options: LayoutOptions = {}) {
  const mounted = mountState<LayoutState>(
    { layout, narrow: false, availableWidth: options.width ?? 1400 },
    (props) => {
      const panels = definitions();
      return (
        <SidebarFixture
          presentationId={options.presentationId ?? "sidebar-layout-fixture"}
          availableWidth={props.value.availableWidth}
          layout={props.value.layout}
          narrow={props.value.narrow}
          panelDefinitions={panels}
          callbacks={{
            ...sidebarCallbacks(),
            closeSlot: (slot) =>
              mounted.modify((value) => ({ ...value, layout: closeSlot(value.layout, slot) })),
          }}
          primary={
            <main data-primary>
              <textarea />
            </main>
          }
        />
      );
    },
    options.container ? { container: options.container } : undefined,
  );
  const { container } = mounted;
  const draw = async (next: SidebarLayout, narrow = false, width = narrow ? 620 : 1400) => {
    mounted.update({ layout: next, narrow, availableWidth: width });
    await container.querySelector("openclaw-chat-sidebar-region")?.updateComplete;
  };
  await draw(layout, false, options.width ?? 1400);
  return { container, draw, layout: () => mounted.read().layout };
}

describe("chat pane sidebar layout", () => {
  it.each(["surviving opener", "removed opener", "outside focus"] as const)(
    "restores side-panel focus with a %s",
    async (scenario) => {
      const layout = openSlot({ columns: [] }, "detail");
      const mounted = mountState({ locked: false, showOpener: true, open: true }, (props) => (
        <>
          <button data-outside>Outside</button>
          <SidebarFixture
            presentationId="focus-return"
            layout={setSidebarOpen(layout, props.value.open)}
            sideFocusLocked={props.value.locked}
            sideFocusManaged={true}
            primary={<main>Conversation</main>}
            panelDefinitions={definitions(["detail"])}
            header={
              <>
                <Show when={props.value.showOpener}>
                  <button data-opener>Open panel</button>
                </Show>
                <button>Actions</button>
              </>
            }
          />
        </>
      ));
      const { container } = mounted;
      const region = container.querySelector("openclaw-chat-sidebar-region")!;
      await region.updateComplete;
      const opener = container.querySelector<HTMLButtonElement>("[data-opener]")!;
      opener.focus();
      mounted.modify((state) => ({ ...state, locked: true }));
      await region.updateComplete;
      container.querySelector<HTMLInputElement>("[data-detail] input")!.focus();
      if (scenario !== "surviving opener") {
        mounted.modify((state) => ({ ...state, showOpener: false }));
      }
      const outside = container.querySelector<HTMLButtonElement>("[data-outside]")!;
      if (scenario === "outside focus") {
        outside.focus();
      }
      mounted.modify((state) => ({ ...state, locked: false, open: false }));
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

  it("keeps native content and the parent layout writable when the DOM provider changes", async () => {
    // SAFETY: the region transports application context; this fixture's panel reads no capabilities.
    const container = createApplicationContextProvider({} as ApplicationContext);
    onTestFinished(() => container.remove());
    document.body.append(container);
    const layout = openSlot({ columns: [] }, "detail");
    const { draw } = await layoutFixture(layout, { container });
    const region = container.querySelector("openclaw-chat-sidebar-region")!;
    const primary = container.querySelector("[data-primary]");
    const detail = container.querySelector("[data-detail]")!;
    const checkbox = detail.querySelector("input")!;
    checkbox.checked = true;

    container.setContext({} as ApplicationContext);
    await region.updateComplete;
    expect(container.querySelector("[data-detail]")).toBe(detail);
    expect(checkbox.checked).toBe(true);

    await draw(promoteSidebarPanel(layout, "detail"));
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
      const presentationId = JSON.stringify(presentation);
      const { container, draw } = await layoutFixture(layout, { presentationId });
      const detail = container.querySelector("[data-detail]")!;
      const primary = container.querySelector("[data-primary]")!;
      for (const next of [layout, promoteSidebarPanel(layout, "detail"), layout]) {
        await draw(next);
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
    const { container: parent, layout } = await layoutFixture(
      openSlot(openSlot({ columns: [] }, "workspace"), "detail"),
    );
    const region = parent.querySelector("openclaw-chat-sidebar-region")!;
    parent.querySelector<HTMLTextAreaElement>("[data-detail] textarea")!.focus();

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
    const open = openSlot({ columns: [] }, "detail");
    const { container, draw } = await layoutFixture({ columns: [], open: false });
    const primary = container.querySelector("[data-primary]");
    const draft = primary!.querySelector("textarea")!;
    draft.value = "Keep this draft";
    await draw(open);
    const detail = container.querySelector<HTMLElement>("[data-detail]")!;
    const checkbox = detail.querySelector("input")!;
    checkbox.checked = true;
    expect(container.querySelector("[data-primary]")).toBe(primary);
    const promoted = promoteSidebarPanel(open, "detail");
    for (const dock of ["left", "right", "bottom"] as const) {
      await draw(setSidebarDock(promoted, dock));
      expect(detail.closest("[data-region]")?.getAttribute("data-region")).toBe("main");
      expect(primary?.closest("[data-region]")?.getAttribute("data-region")).toBe("side");
      expect(primary?.closest("[data-region]")?.hasAttribute("hidden")).toBe(false);
      expect(container.querySelector("[data-detail]")).toBe(detail);
      expect(container.querySelector("[data-primary]")).toBe(primary);
    }
    await draw(setSidebarExpanded(promoted, true));
    expect(primary?.closest("[data-region]")?.hasAttribute("hidden")).toBe(true);
    expect(detail.closest("[data-region]")?.hasAttribute("hidden")).toBe(false);
    await draw(setSidebarOpen(promoted, false));
    expect(primary?.closest("[data-region]")?.hasAttribute("hidden")).toBe(true);
    await draw(setSidebarOpen(promoted, true), true);
    expect(primary?.closest("[data-region]")?.hasAttribute("hidden")).toBe(false);
    expect(container.querySelector(".sidebar-region--narrow")).not.toBeNull();
    const conversation = promoted.columns[0]!.panels.find(
      (panel) => panel.slot === "conversation",
    )!;
    await draw(promoteSidebarPanel(promoted, conversation.id));
    expect(primary?.closest("[data-region]")?.getAttribute("data-region")).toBe("main");
    expect(container.querySelector("[data-detail]")).toBe(detail);
    expect(container.querySelector("[data-primary]")).toBe(primary);
    expect(draft.value).toBe("Keep this draft");
    expect(checkbox.checked).toBe(true);
  });

  it("keeps an unmeasured shell in the wide layout", async () => {
    const { container } = await layoutFixture(openSlot({ columns: [] }, "detail"), { width: 0 });
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
    const layout = boardLayout({ ...openSlot({ columns: [] }, "terminal"), dock: "bottom" });

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

  it("persists tab selection without changing the chosen main content", () => {
    const stored = promoteSidebarPanel(
      openSlot(openSlot({ columns: [] }, "terminal"), "dashboard"),
      "dashboard",
    );
    const { state, callbacks: actions } = callbackFixture(boardLayout(stored), stored);
    actions.activatePanel("terminal");

    expect(state.updateSidebarLayout).toHaveBeenCalledWith(
      expect.objectContaining({
        mainPanelId: "dashboard",
        columns: [expect.objectContaining({ activePanelId: "terminal" })],
      }),
    );
    expect(state.updateSidebarActivePanel).toHaveBeenCalledWith("terminal");
  });

  it("closes dashboard presentation through its owner without minimizing unrelated tabs", () => {
    const {
      state,
      callbacks: actions,
      closePanelSlot,
      setPanelOpen,
    } = callbackFixture(boardLayout({ columns: [] }));
    actions.closeSlot("dashboard");

    expect(closePanelSlot).toHaveBeenCalledWith("dashboard");
    expect(setPanelOpen).not.toHaveBeenCalled();
    expect(state.updateSidebarLayout).not.toHaveBeenCalled();
  });

  it("keeps an empty dashboard open and only removes it when dashboard support is unavailable", () => {
    const layout = promoteSidebarPanel(
      openSlot(openSlot({ columns: [] }, "dashboard"), "detail"),
      "dashboard",
    );
    const loading = { ...board(), hasBoard: false };
    const awaitingSnapshot = boardLayout(layout, {
      ...loading,
      provider: { hasLoadedSnapshot: false },
    } as ResolvedBoardView);
    expect(awaitingSnapshot).toEqual(layout);
    expect(boardLayout(layout, loading)).toEqual(layout);
    const removed = boardLayout(layout, { ...loading, available: false });
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
