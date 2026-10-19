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
  type SidebarSlotId,
} from "./sidebar-layout.ts";

function column(
  panels: SidebarLayout["columns"][number]["panels"] = [],
  extra: Partial<SidebarLayout["columns"][number]> = {},
) {
  return {
    id: "side-panel-column",
    side: "right" as const,
    panels,
    activePanelId: "",
    height: 360,
    width: 480,
    ...extra,
  };
}

function expectVisible(layout: SidebarLayout, shown: SidebarSlotId, hidden?: SidebarSlotId) {
  expect(isSidebarSlotVisible(layout, shown)).toBe(true);
  if (hidden) {
    expect(isSidebarSlotVisible(layout, hidden)).toBe(false);
  }
}
function persistedColumn(id: string, panels: { id: string; slot: string }[], extra = {}) {
  return { id, side: "right", panels, ...extra };
}
const storedPanel = (id: string, slot = id) => ({ id, slot });

function openAll(): SidebarLayout {
  return openSlot(openSlot(openSlot({ columns: [] }, "discussion"), "dashboard"), "detail");
}

describe("sidebar layout", () => {
  it("restores the original right split after focusing the side in place", () => {
    const split = normalizeSidebarLayout(
      ensureSidebarConversation(setSidebarDock(activatePanel(openAll(), "dashboard"), "right")),
    );
    const focused = toggleSidebarPanelExpanded(split, "dashboard");
    expect(sidebarMainPanel(focused)).toEqual(sidebarMainPanel(split));
    expect(focused.columns).toEqual(split.columns);
    expectVisible(focused, "dashboard", "conversation");
    expect(toggleSidebarPanelExpanded(normalizeSidebarLayout(focused), "dashboard")).toEqual(split);
    const closed = setSidebarOpen(focused, false);
    expectVisible(closed, "conversation", "dashboard");
    expect(setSidebarOpen(closed, true)).toEqual(split);
  });

  it("expands inactive tabs and exits side focus on normal activation or closing its tab", () => {
    const split = normalizeSidebarLayout(ensureSidebarConversation(openAll()));
    const focused = toggleSidebarPanelExpanded(split, "dashboard");
    expect(sidebarActivePanel(focused)?.slot).toBe("dashboard");
    expect(sidebarMainPanel(focused)).toEqual(sidebarMainPanel(split));
    expect(activatePanel(focused, "detail")).toEqual(split);
    expect(isSidebarSlotVisible(openSlot(focused, "conversation"), "conversation")).toBe(true);
    const closed = closeSlot(focused, "dashboard");
    expect(closed.expanded).toBe(false);
    expectVisible(closed, "conversation");
    expectVisible(closed, "detail");
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
    expectVisible(layout, "conversation");
    expect(layout.expandedSide).toBeUndefined();
  });

  it("shows a narrow pane's open background panel in place of the main view, and nothing else", () => {
    const saved = openSlot(openSlot({ columns: [] }, "terminal"), "subagents");
    const before = structuredClone(saved);
    const shown = presentNarrowSidebarLayout(saved);
    expectVisible(shown, "subagents", "conversation");
    expect(saved).toEqual(before);
    expect(presentNarrowSidebarLayout(saved)).toBe(shown);
    expect(
      isSidebarSlotVisible(
        presentNarrowSidebarLayout(openSlot(saved, "processes")),
        "conversation",
      ),
    ).toBe(false);
    for (const layout of [
      openSlot(saved, "terminal"),
      setSidebarOpen(saved, false),
      setSidebarExpanded(saved, true),
      toggleSidebarPanelExpanded(saved, sidebarActivePanel(saved)!.id),
    ]) {
      expect(presentNarrowSidebarLayout(layout)).toBe(layout);
    }
  });

  it.each([false, true])(
    "presents mobile tools without changing the desktop (promoted=%s)",
    (promoted) => {
      const base = ensureSidebarConversation(
        promoted ? openSlot({ columns: [] }, "dashboard") : { columns: [] },
      );
      const layout = promoted ? promoteSidebarPanel(base, "dashboard") : base;
      const main = promoted ? "dashboard" : "conversation";
      const slots: SidebarSlotId[] = promoted
        ? ["workspace", "terminal"]
        : ["workspace", "terminal", "browser", "dashboard", "subagents", "processes"];
      for (const slot of slots) {
        const saved = openSlot(layout, slot);
        const before = structuredClone(saved);
        const shown = presentNarrowSidebarLayout(saved, { allPanels: true });
        expectVisible(shown, slot, main);
        expect(sidebarMainPanel(shown)?.slot).toBe(main);
        expect(presentNarrowSidebarLayout(saved, { allPanels: true })).toBe(shown);
        expect(saved).toEqual(before);
        expectVisible(saved, main);
        const closed = setSidebarOpen(saved, false);
        expect(presentNarrowSidebarLayout(closed, { allPanels: true })).toBe(closed);
      }
    },
  );

  it("presents Chat over a promoted page on mobile without changing the desktop split", () => {
    const split = ensureSidebarConversation(openSlot({ columns: [] }, "dashboard"));
    const promoted = promoteSidebarPanel(split, sidebarActivePanel(split)!.id);
    expect(sidebarMainPanel(promoted)?.slot).toBe("dashboard");
    const mobile = presentNarrowSidebarLayout(promoted, { allPanels: true });
    expectVisible(mobile, "conversation", "dashboard");
    expect(presentNarrowSidebarLayout(promoted)).toBe(promoted);
    expectVisible(
      presentNarrowSidebarLayout(closeSlot(promoted, "conversation"), { allPanels: true }),
      "dashboard",
    );
    expectVisible(promoted, "dashboard");
    expectVisible(promoted, "conversation");
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
      columns: [column([], { browserWidthPending: true })],
      open: false,
    });
  });

  it("focuses main independently and restores the side selection when reopened", () => {
    const layout = promoteSidebarPanel(openAll(), "dashboard");
    const focused = setSidebarExpanded(layout, true);
    expectVisible(focused, "dashboard", "conversation");
    expect(openSlot(focused, "dashboard")).toEqual(focused);

    const minimized = setSidebarOpen(focused, false);
    expectVisible(minimized, "dashboard");
    const reopened = setSidebarOpen(minimized, true);
    expectVisible(reopened, "conversation");
    expect(sidebarMainPanel(reopened)?.slot).toBe("dashboard");
    const openedDetail = openSlot(focused, "detail");
    expectVisible(openedDetail, "detail");
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
    expectVisible(finalPanel, "conversation");
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
      columns: [persistedColumn("side", [storedPanel("browser")], { width: 480 })],
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
      const legacyColumn = column([], { activePanelId: "chat", height: 520, width: 640 });
      const legacyPanels = [storedPanel("chat"), storedPanel("terminal")];
      const layout = normalizeSidebarLayout({
        columns: [{ ...legacyColumn, panels: legacyPanels }],
        dock: "bottom",
        open,
        expanded: true,
      });
      expect(layout).toEqual({
        columns: [
          {
            ...legacyColumn,
            panels: [
              storedPanel("chat", "dashboard"),
              storedPanel("terminal"),
              { id: "conversation", slot: "conversation" },
            ],
            activePanelId: open ? "conversation" : "chat",
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
      columns: [column()],
      dock: "right",
      open: true,
      expanded: false,
    });
    expect(
      normalizeSidebarLayout({
        columns: [persistedColumn("review", [storedPanel("detail")])],
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
          persistedColumn("same", [storedPanel("same-panel", "detail"), storedPanel("unknown")], {
            activePanelId: "missing",
            width: 20,
          }),
          persistedColumn(
            "same",
            [storedPanel("same-panel", "discussion"), storedPanel("duplicate-slot", "detail")],
            { side: "left", activePanelId: "same-panel", width: 50_000 },
          ),
        ],
        open: false,
        expanded: true,
      }),
    ).toEqual({
      columns: [
        column(
          [
            { id: "same-panel", slot: "detail" },
            { id: "same-panel-2", slot: "discussion" },
            { id: "conversation", slot: "conversation" },
          ],
          { id: "same", activePanelId: "same-panel-2", width: 1_200 },
        ),
      ],
      mainPanelId: "conversation",
      dock: "right",
      open: false,
      expanded: true,
    });
  });
});
