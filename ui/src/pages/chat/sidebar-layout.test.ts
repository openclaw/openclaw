import { describe, expect, it } from "vitest";
import {
  SIDEBAR_MIN_WIDTH_PX,
  activatePanel,
  closeSlot,
  ensureSidebarConversation,
  fitSidebarLayout,
  initializeBrowserSidebarWidth,
  isSidebarSlotVisible,
  normalizeSidebarLayout,
  openSlot,
  presentNarrowSidebarLayout,
  promoteSidebarPanel,
  reorderPanel,
  resizeSidebarPanel,
  setSidebarDock,
  setSidebarExpanded,
  toggleSidebarPanelExpanded,
  setSidebarOpen,
  sidebarActivePanel,
  sidebarMainPanel,
  sidebarSidePanels,
  type SidebarLayout,
} from "./sidebar-layout.ts";

function openAll(): SidebarLayout {
  return openSlot(openSlot(openSlot({ columns: [] }, "discussion"), "dashboard"), "detail");
}

describe("sidebar layout", () => {
  it.each(["right"] as const)(
    "restores the original %s split after focusing the side in place",
    (dock) => {
      const split = normalizeSidebarLayout(
        ensureSidebarConversation(setSidebarDock(activatePanel(openAll(), "dashboard"), dock)),
      );
      const focused = toggleSidebarPanelExpanded(split, "dashboard");
      expect(sidebarMainPanel(focused)).toEqual(sidebarMainPanel(split));
      expect(focused.columns).toEqual(split.columns);
      expect(isSidebarSlotVisible(focused, "dashboard")).toBe(true);
      expect(isSidebarSlotVisible(focused, "conversation")).toBe(false);
      expect(toggleSidebarPanelExpanded(normalizeSidebarLayout(focused), "dashboard")).toEqual(
        split,
      );
      const closed = setSidebarOpen(focused, false);
      expect(isSidebarSlotVisible(closed, "conversation")).toBe(true);
      expect(isSidebarSlotVisible(closed, "dashboard")).toBe(false);
      expect(setSidebarOpen(closed, true)).toEqual(split);
    },
  );

  it("expands inactive tabs and exits side focus on normal activation or closing its tab", () => {
    const split = normalizeSidebarLayout(ensureSidebarConversation(openAll()));
    const focused = toggleSidebarPanelExpanded(split, "dashboard");
    expect(sidebarActivePanel(focused)?.slot).toBe("dashboard");
    expect(sidebarMainPanel(focused)).toEqual(sidebarMainPanel(split));
    expect(activatePanel(focused, "detail")).toEqual(split);
    expect(isSidebarSlotVisible(openSlot(focused, "conversation"), "conversation")).toBe(true);
    const closed = closeSlot(focused, "dashboard");
    expect(closed.expanded).toBe(false);
    expect(isSidebarSlotVisible(closed, "conversation")).toBe(true);
    expect(isSidebarSlotVisible(closed, "detail")).toBe(true);
    expect(toggleSidebarPanelExpanded(split, "missing")).toEqual(split);
    expect(toggleSidebarPanelExpanded(split, split.mainPanelId!)).toEqual(split);
  });

  it("does not hide the main view when stored side focus has no surviving side panel", () => {
    const layout = normalizeSidebarLayout({
      columns: [],
      expanded: true,
      expandedSide: true,
      open: true,
    });
    expect(isSidebarSlotVisible(layout, "conversation")).toBe(true);
    expect(layout.expandedSide).toBeUndefined();
  });

  it("shows a narrow pane's open background panel in place of the main view, and nothing else", () => {
    const saved = openSlot(openSlot({ columns: [] }, "terminal"), "subagents");
    const before = structuredClone(saved);
    const shown = presentNarrowSidebarLayout(saved);
    expect(isSidebarSlotVisible(shown, "subagents")).toBe(true);
    expect(isSidebarSlotVisible(shown, "conversation")).toBe(false);
    // Presentation only: the layout is untouched and the same view comes back each time.
    expect(saved).toEqual(before);
    expect(presentNarrowSidebarLayout(saved)).toBe(shown);
    expect(
      isSidebarSlotVisible(
        presentNarrowSidebarLayout(openSlot(saved, "processes")),
        "conversation",
      ),
    ).toBe(false);
    // Every other state is shown as it is: another panel, a closed side, a focused main view.
    for (const layout of [
      openSlot(saved, "terminal"),
      setSidebarOpen(saved, false),
      setSidebarExpanded(saved, true),
      toggleSidebarPanelExpanded(saved, sidebarActivePanel(saved)!.id),
    ]) {
      expect(presentNarrowSidebarLayout(layout)).toBe(layout);
    }
  });

  it("presents every open mobile panel full-width without changing the saved desktop layout", () => {
    for (const slot of [
      "workspace",
      "terminal",
      "browser",
      "dashboard",
      "subagents",
      "processes",
    ] as const) {
      const saved = openSlot(ensureSidebarConversation({ columns: [] }), slot);
      const before = structuredClone(saved);
      const shown = presentNarrowSidebarLayout(saved, { allPanels: true });
      expect(isSidebarSlotVisible(shown, slot)).toBe(true);
      expect(isSidebarSlotVisible(shown, "conversation")).toBe(false);
      expect(presentNarrowSidebarLayout(saved, { allPanels: true })).toBe(shown);
      expect(saved).toEqual(before);
      expect(isSidebarSlotVisible(saved, "conversation")).toBe(true);
      const closed = setSidebarOpen(saved, false);
      expect(presentNarrowSidebarLayout(closed, { allPanels: true })).toBe(closed);
    }
  });

  it("keeps a promoted main view visible when restoring a mobile split", () => {
    const split = ensureSidebarConversation(openSlot({ columns: [] }, "dashboard"));
    const promoted = promoteSidebarPanel(split, sidebarActivePanel(split)!.id);
    expect(sidebarMainPanel(promoted)?.slot).toBe("dashboard");
    expect(presentNarrowSidebarLayout(promoted, { allPanels: true })).toBe(promoted);
    expect(isSidebarSlotVisible(promoted, "dashboard")).toBe(true);
    expect(isSidebarSlotVisible(promoted, "conversation")).toBe(true);
  });

  it("presents newly selected mobile tools over a promoted main view without changing it", () => {
    const split = ensureSidebarConversation(openSlot({ columns: [] }, "dashboard"));
    const promoted = promoteSidebarPanel(split, sidebarActivePanel(split)!.id);
    for (const slot of ["workspace", "terminal"] as const) {
      const saved = openSlot(promoted, slot);
      const before = structuredClone(saved);
      const shown = presentNarrowSidebarLayout(saved, { allPanels: true });
      expect(isSidebarSlotVisible(shown, slot)).toBe(true);
      expect(isSidebarSlotVisible(shown, "dashboard")).toBe(false);
      expect(sidebarMainPanel(shown)?.slot).toBe("dashboard");
      expect(saved).toEqual(before);
    }
  });

  it("reorders tabs without changing the active surface", () => {
    const layout = openAll();
    const [discussion, dashboard, detail] = layout.columns[0]!.panels;
    const reordered = reorderPanel(layout, discussion!.id, detail!.id, "after");

    expect(reordered.columns[0]?.panels.map((panel) => panel.slot)).toEqual([
      "dashboard",
      "detail",
      "discussion",
    ]);
    expect(reordered.columns[0]?.activePanelId).toBe(detail!.id);
    expect(layout.columns[0]?.panels[0]?.id).toBe(discussion!.id);
    expect(dashboard?.slot).toBe("dashboard");
  });

  it("collapses the panel after its final tab closes", () => {
    const closed = closeSlot(openSlot({ columns: [] }, "detail"), "detail");
    expect(closed).toEqual({
      columns: [
        {
          browserWidthPending: true,
          id: "side-panel-column",
          side: "right",
          panels: [],
          activePanelId: "",
          height: 360,
          width: 480,
        },
      ],
      open: false,
    });
  });

  it("focuses main independently and restores the side selection when reopened", () => {
    const layout = promoteSidebarPanel(openAll(), "dashboard");
    const focused = setSidebarExpanded(layout, true);
    expect(isSidebarSlotVisible(focused, "dashboard")).toBe(true);
    expect(isSidebarSlotVisible(focused, "conversation")).toBe(false);
    expect(openSlot(focused, "dashboard")).toEqual(focused);

    const minimized = setSidebarOpen(focused, false);
    expect(isSidebarSlotVisible(minimized, "dashboard")).toBe(true);
    const reopened = setSidebarOpen(minimized, true);
    expect(isSidebarSlotVisible(reopened, "conversation")).toBe(true);
    expect(sidebarMainPanel(reopened)?.slot).toBe("dashboard");
    const openedDetail = openSlot(focused, "detail");
    expect(isSidebarSlotVisible(openedDetail, "detail")).toBe(true);
    expect(sidebarMainPanel(openedDetail)?.slot).toBe("dashboard");
    expect(promoteSidebarPanel(focused, "detail").expanded).toBe(false);
  });

  it("restores conversation when main closes and retains the other side tabs", () => {
    const layout = promoteSidebarPanel(openAll(), "dashboard");
    const withoutConversation = closeSlot(layout, "conversation");
    expect(withoutConversation.open).toBe(false);
    expect(withoutConversation.columns[0]?.panels).toEqual(layout.columns[0]?.panels);

    const closed = closeSlot(layout, "dashboard");
    expect(sidebarMainPanel(closed)?.slot).toBe("conversation");
    expect(sidebarSidePanels(closed).map((panel) => panel.slot)).toEqual(["discussion", "detail"]);
    expect(sidebarActivePanel(closed)?.slot).toBe("discussion");
    expect(closed.open).toBe(true);
    expect(closeSlot(closed, "conversation")).toEqual(closed);

    const finalPanel = closeSlot(
      promoteSidebarPanel(openSlot({ columns: [] }, "dashboard"), "dashboard"),
      "dashboard",
    );
    expect(isSidebarSlotVisible(finalPanel, "conversation")).toBe(true);
    expect(finalPanel.open).toBe(false);
  });

  it("clamps and fits the single inherited resizable column", () => {
    const layout = openAll();
    const columnId = layout.columns[0]!.id;
    expect(resizeSidebarPanel(layout, columnId, 1).columns[0]?.width).toBe(SIDEBAR_MIN_WIDTH_PX);
    expect(resizeSidebarPanel(layout, columnId, Number.MAX_VALUE).columns[0]?.width).toBe(1_200);
    expect(
      fitSidebarLayout(resizeSidebarPanel(layout, columnId, 1_000), 1_200)?.columns[0]?.width,
    ).toBe(720);
    expect(fitSidebarLayout(layout, 560)).toBeNull();
  });

  it("defers browser sizing in narrow and bottom layouts and preserves manual or legacy widths", () => {
    const layout = normalizeSidebarLayout(openSlot({ columns: [] }, "browser"));
    expect(initializeBrowserSidebarWidth(layout, 500, 464)).toEqual(layout);
    const bottom = setSidebarDock(layout, "bottom");
    expect(initializeBrowserSidebarWidth(bottom, 1_800, 804)).toEqual(bottom);
    const resized = normalizeSidebarLayout(resizeSidebarPanel(layout, layout.columns[0]!.id, 480));
    expect(initializeBrowserSidebarWidth(resized, 1_800, 804)).toEqual(resized);
    const legacy = normalizeSidebarLayout({
      columns: [
        { id: "side", side: "right", panels: [{ id: "browser", slot: "browser" }], width: 480 },
      ],
    });
    expect(initializeBrowserSidebarWidth(legacy, 1_800, 804)).toEqual(legacy);
    expect(initializeBrowserSidebarWidth(layout, 1_800, 804).columns[0]?.width).toBe(990);
  });

  it("persists and resizes the same panel at the bottom", () => {
    const layout = setSidebarDock(openAll(), "bottom");
    const columnId = layout.columns[0]!.id;
    const resized = resizeSidebarPanel(layout, columnId, 480);

    expect(resized.dock).toBe("bottom");
    expect(resized.columns[0]?.height).toBe(480);
    expect(resized.columns[0]?.width).toBe(480);
    expect(fitSidebarLayout(resized, 560)).toEqual(resized);
  });

  it.each([true, false])(
    "migrates a legacy expanded dashboard with open=%s without changing visible content",
    (open) => {
      const layout = normalizeSidebarLayout({
        columns: [
          {
            id: "side-panel-column",
            side: "right",
            panels: [
              { id: "chat", slot: "chat" },
              { id: "terminal", slot: "terminal" },
            ],
            activePanelId: "chat",
            height: 520,
            width: 640,
          },
        ],
        dock: "bottom",
        open,
        expanded: true,
      });
      expect(layout).toEqual({
        columns: [
          {
            id: "side-panel-column",
            side: "right",
            panels: [
              { id: "chat", slot: "dashboard" },
              { id: "terminal", slot: "terminal" },
              { id: "conversation", slot: "conversation" },
            ],
            activePanelId: open ? "conversation" : "chat",
            height: 520,
            width: 640,
          },
        ],
        mainPanelId: open ? "chat" : "conversation",
        dock: "bottom",
        open,
        expanded: true,
      });
      expect(isSidebarSlotVisible(layout, "dashboard")).toBe(open);
      expect(isSidebarSlotVisible(layout, "conversation")).toBe(!open);
      expect(normalizeSidebarLayout(layout)).toEqual(layout);
    },
  );

  it("deduplicates slots and repairs untrusted persisted values", () => {
    expect(normalizeSidebarLayout(null)).toEqual({ columns: [], open: false, expanded: false });
    expect(normalizeSidebarLayout({ columns: [], open: true })).toEqual({
      columns: [
        {
          id: "side-panel-column",
          side: "right",
          panels: [],
          activePanelId: "",
          height: 360,
          width: 480,
        },
      ],
      dock: "right",
      open: true,
      expanded: false,
    });
    expect(
      normalizeSidebarLayout({
        columns: [
          {
            id: "review",
            side: "right",
            panels: [{ id: "detail", slot: "detail" }],
          },
        ],
      }).columns[0]?.width,
    ).toBe(480);
    expect(normalizeSidebarLayout({ columns: "nope" })).toEqual({
      columns: [],
      open: false,
      expanded: false,
    });
    expect(
      normalizeSidebarLayout({
        columns: [
          {
            id: "same",
            side: "right",
            panels: [
              { id: "same-panel", slot: "detail" },
              { id: "unknown", slot: "unknown" },
            ],
            activePanelId: "missing",
            width: 20,
          },
          {
            id: "same",
            side: "left",
            panels: [
              { id: "same-panel", slot: "discussion" },
              { id: "duplicate-slot", slot: "detail" },
            ],
            activePanelId: "same-panel",
            width: 50_000,
          },
        ],
        open: false,
        expanded: true,
      }),
    ).toEqual({
      columns: [
        {
          id: "same",
          side: "right",
          panels: [
            { id: "same-panel", slot: "detail" },
            { id: "same-panel-2", slot: "discussion" },
            { id: "conversation", slot: "conversation" },
          ],
          activePanelId: "same-panel-2",
          height: 360,
          width: 1_200,
        },
      ],
      mainPanelId: "conversation",
      dock: "right",
      open: false,
      expanded: true,
    });
  });
});
