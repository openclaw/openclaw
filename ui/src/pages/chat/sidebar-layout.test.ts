import { expect, it } from "vitest";
import {
  SIDEBAR_MIN_WIDTH_PX,
  activatePanel,
  closeSlot,
  ensureSidebarConversation as withConversation,
  fitSidebarLayout as fitLayout,
  initializeBrowserSidebarWidth as initBrowserWidth,
  isSidebarSlotVisible,
  normalizeSidebarLayout as normalize,
  openSlot,
  presentNarrowSidebarLayout as narrow,
  promoteSidebarPanel as promotePanel,
  reorderPanel,
  resizeSidebarPanel as resizePanel,
  setSidebarDock,
  setSidebarExpanded,
  toggleSidebarPanelExpanded as toggleExpanded,
  setSidebarOpen,
  sidebarActivePanel as activePanel,
  sidebarMainPanel as mainPanel,
  sidebarSidePanels as sidePanels,
  type SidebarLayout,
  type SidebarSlotId,
} from "./sidebar-layout.ts";

type Column = SidebarLayout["columns"][number];
function column(panels: Column["panels"] = [], extra: Partial<Column> = {}) {
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
function storedColumn(id: string, panels: { id: string; slot: string }[], extra = {}) {
  return { id, side: "right", panels, ...extra };
}
const tab = <Slot extends string>(slot: Slot, id: string = slot) => ({ id, slot });

function openAll(): SidebarLayout {
  return openSlot(openSlot(openSlot({ columns: [] }, "discussion"), "dashboard"), "detail");
}

it.each(["dashboard", undefined])(
  "restores the original right split after focusing the side with panelId=%s",
  (panelId) => {
    const split = normalize(
      withConversation(setSidebarDock(activatePanel(openAll(), "dashboard"), "right")),
    );
    const focused = toggleExpanded(split, panelId);
    expect(mainPanel(focused)).toEqual(mainPanel(split));
    expect(focused.columns).toEqual(split.columns);
    expectVisible(focused, "dashboard", "conversation");
    expect(toggleExpanded(normalize(focused), panelId)).toEqual(split);
    const closed = setSidebarOpen(focused, false);
    expectVisible(closed, "conversation", "dashboard");
    expect(setSidebarOpen(closed, true)).toEqual(split);
  },
);

it.each(["left", "right", "bottom"] as const)(
  "expands and restores an empty %s container without adding a tool or losing geometry",
  (dock) => {
    const opened = setSidebarOpen({ columns: [] }, true);
    const columnId = opened.columns[0]!.id;
    const sized = resizePanel(
      setSidebarDock(resizePanel(opened, columnId, 620), "bottom"),
      columnId,
      410,
    );
    const split = normalize(withConversation(setSidebarDock(sized, dock)));
    const before = structuredClone(split);
    const focused = toggleExpanded(split);
    expect(focused).toMatchObject({ open: true, expanded: true, expandedSide: true, dock });
    expect(sidePanels(focused)).toEqual([]);
    expect(activePanel(focused)).toBeUndefined();
    expect(mainPanel(focused)).toEqual({ id: "conversation", slot: "conversation" });
    expect(focused.columns).toEqual(before.columns);
    expect(split).toEqual(before);
    const restored = toggleExpanded(normalize(focused));
    expect(restored).toEqual(before);
    expect(isSidebarSlotVisible(restored, "conversation")).toBe(true);
  },
);

it("retains stored expansion of an empty container and restores the chat", () => {
  const layout = normalize({
    columns: [{ id: "side", side: "right", panels: [], width: 620, height: 410 }],
    expanded: true,
    expandedSide: true,
    open: true,
  });
  expect(layout.expandedSide).toBe(true);
  expect(sidePanels(layout)).toEqual([]);
  expect(isSidebarSlotVisible(layout, "conversation")).toBe(false);
  expect(normalize(layout)).toEqual(layout);
  const restored = setSidebarExpanded(layout, false);
  expect(isSidebarSlotVisible(restored, "conversation")).toBe(true);
  expect(restored.columns[0]).toMatchObject({ width: 620, height: 410 });
  expect(normalize({ ...layout, open: false }).expandedSide).toBeUndefined();
});

it("expands inactive tabs and exits side focus on normal activation or closing its tab", () => {
  const split = normalize(withConversation(openAll()));
  const focused = toggleExpanded(split, "dashboard");
  expect(activePanel(focused)?.slot).toBe("dashboard");
  expect(mainPanel(focused)).toEqual(mainPanel(split));
  expect(activatePanel(focused, "detail")).toEqual(split);
  expect(isSidebarSlotVisible(openSlot(focused, "conversation"), "conversation")).toBe(true);
  const closed = closeSlot(focused, "dashboard");
  expect(closed.expanded).toBe(false);
  expectVisible(closed, "conversation");
  expectVisible(closed, "detail");
  expect(toggleExpanded(split, "missing")).toEqual(split);
  expect(toggleExpanded(split, split.mainPanelId!)).toEqual(split);
});

it("does not hide the main view when stored side focus has no surviving side panel", () => {
  const layout = normalize({ columns: [], expanded: true, expandedSide: true, open: true });
  expectVisible(layout, "conversation");
  expect(layout.expandedSide).toBeUndefined();
});

it("shows a narrow pane's open background panel in place of the main view, and nothing else", () => {
  const saved = openSlot(openSlot({ columns: [] }, "terminal"), "subagents");
  const before = structuredClone(saved);
  const shown = narrow(saved);
  expectVisible(shown, "subagents", "conversation");
  expect(saved).toEqual(before);
  expect(narrow(saved)).toBe(shown);
  expect(isSidebarSlotVisible(narrow(openSlot(saved, "processes")), "conversation")).toBe(false);
  for (const layout of [
    openSlot(saved, "terminal"),
    setSidebarOpen(saved, false),
    setSidebarExpanded(saved, true),
    toggleExpanded(saved, activePanel(saved)!.id),
  ]) {
    expect(narrow(layout)).toBe(layout);
  }
});

it.each([false, true])(
  "presents mobile tools without changing the desktop (promoted=%s)",
  (promoted) => {
    const base = withConversation(
      promoted ? openSlot({ columns: [] }, "dashboard") : { columns: [] },
    );
    const layout = promoted ? promotePanel(base, "dashboard") : base;
    const main = promoted ? "dashboard" : "conversation";
    const slots: SidebarSlotId[] = promoted
      ? ["workspace", "terminal"]
      : ["workspace", "terminal", "browser", "dashboard", "subagents", "processes"];
    for (const slot of slots) {
      const saved = openSlot(layout, slot);
      const before = structuredClone(saved);
      const shown = narrow(saved, { allPanels: true });
      expectVisible(shown, slot, main);
      expect(mainPanel(shown)?.slot).toBe(main);
      expect(narrow(saved, { allPanels: true })).toBe(shown);
      expect(saved).toEqual(before);
      expectVisible(saved, main);
      const closed = setSidebarOpen(saved, false);
      expect(narrow(closed, { allPanels: true })).toBe(closed);
    }
  },
);

it("presents Chat over a promoted page on mobile without changing the desktop split", () => {
  const split = withConversation(openSlot({ columns: [] }, "dashboard"));
  const promoted = promotePanel(split, activePanel(split)!.id);
  expect(mainPanel(promoted)?.slot).toBe("dashboard");
  const mobile = narrow(promoted, { allPanels: true });
  expectVisible(mobile, "conversation", "dashboard");
  expect(narrow(promoted)).toBe(promoted);
  expectVisible(narrow(closeSlot(promoted, "conversation"), { allPanels: true }), "dashboard");
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
  const layout = promotePanel(openAll(), "dashboard");
  const focused = setSidebarExpanded(layout, true);
  expectVisible(focused, "dashboard", "conversation");
  expect(openSlot(focused, "dashboard")).toEqual(focused);

  const minimized = setSidebarOpen(focused, false);
  expectVisible(minimized, "dashboard");
  const reopened = setSidebarOpen(minimized, true);
  expectVisible(reopened, "conversation");
  expect(mainPanel(reopened)?.slot).toBe("dashboard");
  const openedDetail = openSlot(focused, "detail");
  expectVisible(openedDetail, "detail");
  expect(mainPanel(openedDetail)?.slot).toBe("dashboard");
  expect(promotePanel(focused, "detail").expanded).toBe(false);
});

it("restores conversation when main closes and retains the other side tabs", () => {
  const layout = promotePanel(openAll(), "dashboard");
  const withoutConversation = closeSlot(layout, "conversation");
  expect(withoutConversation.open).toBe(false);
  expect(withoutConversation.columns[0]?.panels).toEqual(layout.columns[0]?.panels);

  const closed = closeSlot(layout, "dashboard");
  expect(mainPanel(closed)?.slot).toBe("conversation");
  expect(sidePanels(closed).map((panel) => panel.slot)).toEqual(["discussion", "detail"]);
  expect(activePanel(closed)?.slot).toBe("discussion");
  expect(closed.open).toBe(true);
  expect(closeSlot(closed, "conversation")).toEqual(closed);

  const finalPanel = closeSlot(
    promotePanel(openSlot({ columns: [] }, "dashboard"), "dashboard"),
    "dashboard",
  );
  expectVisible(finalPanel, "conversation");
  expect(finalPanel.open).toBe(false);
});

it("clamps and fits the single inherited resizable column", () => {
  const layout = openAll();
  const columnId = layout.columns[0]!.id;
  expect(resizePanel(layout, columnId, 1).columns[0]?.width).toBe(SIDEBAR_MIN_WIDTH_PX);
  expect(resizePanel(layout, columnId, Number.MAX_VALUE).columns[0]?.width).toBe(1_200);
  expect(fitLayout(resizePanel(layout, columnId, 1_000), 1_200)?.columns[0]?.width).toBe(720);
  expect(fitLayout(layout, 560)).toBeNull();
});

it("defers browser sizing in narrow and bottom layouts and preserves manual or legacy widths", () => {
  const layout = normalize(openSlot({ columns: [] }, "browser"));
  expect(initBrowserWidth(layout, 500, 464)).toEqual(layout);
  const bottom = setSidebarDock(layout, "bottom");
  expect(initBrowserWidth(bottom, 1_800, 804)).toEqual(bottom);
  const resized = normalize(resizePanel(layout, layout.columns[0]!.id, 480));
  expect(initBrowserWidth(resized, 1_800, 804)).toEqual(resized);
  const legacy = normalize({
    columns: [storedColumn("side", [tab("browser")], { width: 480 })],
  });
  expect(initBrowserWidth(legacy, 1_800, 804)).toEqual(legacy);
  expect(initBrowserWidth(layout, 1_800, 804).columns[0]?.width).toBe(990);
});

it("persists and resizes the same panel at the bottom", () => {
  const layout = setSidebarDock(openAll(), "bottom");
  const columnId = layout.columns[0]!.id;
  const resized = resizePanel(layout, columnId, 480);

  expect(resized).toMatchObject({ dock: "bottom", columns: [{ height: 480, width: 480 }] });
  expect(fitLayout(resized, 560)).toEqual(resized);
});

it.each([true, false])(
  "migrates a legacy expanded dashboard with open=%s without changing visible content",
  (open) => {
    const legacyColumn = column([], { activePanelId: "chat", height: 520, width: 640 });
    const legacyPanels = [tab("chat"), tab("terminal")];
    const layout = normalize({
      columns: [{ ...legacyColumn, panels: legacyPanels }],
      dock: "bottom",
      open,
      expanded: true,
    });
    expect(layout).toEqual({
      columns: [
        {
          ...legacyColumn,
          panels: [tab("dashboard", "chat"), tab("terminal"), tab("conversation")],
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
    expect(normalize(layout)).toEqual(layout);
  },
);

it("deduplicates slots and repairs untrusted persisted values", () => {
  for (const input of [null, { columns: "nope" }]) {
    expect(normalize(input)).toEqual({ columns: [], open: false, expanded: false });
  }
  expect(normalize({ columns: [], open: true })).toEqual({
    columns: [column()],
    dock: "right",
    open: true,
    expanded: false,
  });
  expect(
    normalize({
      columns: [storedColumn("review", [tab("detail")])],
    }).columns[0]?.width,
  ).toBe(480);
  expect(
    normalize({
      columns: [
        storedColumn("same", [tab("detail", "same-panel"), tab("unknown")], {
          activePanelId: "missing",
          width: 20,
        }),
        storedColumn("same", [tab("discussion", "same-panel"), tab("detail", "duplicate-slot")], {
          side: "left",
          activePanelId: "same-panel",
          width: 50_000,
        }),
      ],
      open: false,
      expanded: true,
    }),
  ).toEqual({
    columns: [
      column(
        [tab("detail", "same-panel"), tab("discussion", "same-panel-2"), tab("conversation")],
        { id: "same", activePanelId: "same-panel-2", width: 1_200 },
      ),
    ],
    mainPanelId: "conversation",
    dock: "right",
    open: false,
    expanded: true,
  });
});
