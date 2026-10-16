import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { applyBoardOps } from "../../../../src/boards/board-layout.js";
import { buildWidgetDocument } from "../../../../src/canvas/wrap.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { BOARD_GRID_GAP, BOARD_GRID_ROW_HEIGHT } from "../../lib/board/grid.ts";
import type { BoardSnapshot } from "../../lib/board/types.ts";
import { boardWidget } from "./board-view.test-support.ts";
import "../../styles/base.css";
import "../../styles/chat/board.css";
import "./board-view.ts";

type OpenClawBoardView = HTMLElementTagNameMap["openclaw-board-view"];
function q<K extends keyof HTMLElementTagNameMap>(
  root: ParentNode,
  selector: K,
): HTMLElementTagNameMap[K];
function q<T extends Element = HTMLElement>(root: ParentNode, selector: string): T;
function q(root: ParentNode, selector: string) {
  return root.querySelector(selector)!;
}
const rect = (element: Element) => element.getBoundingClientRect();
const style = (element: Element) => getComputedStyle(element);
const cellsIn = (view: OpenClawBoardView) => [
  ...view.querySelectorAll("openclaw-board-widget-cell"),
];

const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");

const source: BoardSnapshot = {
  sessionKey: "agent:main:browser-board",
  revision: 1,
  tabs: [
    { tabId: "main", title: "Main", position: 0, chatDock: "right" },
    { tabId: "ops", title: "Operations", position: 1, chatDock: "right" },
  ],
  widgets: ["first", "second"].map((name, position) =>
    boardWidget({
      name,
      title: position ? "Second" : "First",
      sizeH: 3,
      position,
    }),
  ),
};

async function settle(view: OpenClawBoardView) {
  await view.updateComplete;
  await Promise.all(cellsIn(view).map((cell) => cell.updateComplete));
}

async function mount(
  applyOps = vi.fn(async () => undefined),
  parent: HTMLElement = document.body,
): Promise<OpenClawBoardView> {
  const view = document.createElement("openclaw-board-view");
  view.snapshot = structuredClone(source);
  view.activeTabId = "main";
  view.widgetFrameUrl = () => "about:blank";
  view.callbacks = { applyOps, grant: vi.fn(async () => undefined), selectTab: vi.fn() };
  parent.append(view);
  await settle(view);
  return view;
}

function pointer(
  target: EventTarget,
  type: "pointerdown" | "pointermove" | "pointerup",
  pointerId: number,
  clientX = 0,
  clientY = 0,
): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      pointerId,
      clientX,
      clientY,
      button: 0,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function dropAt(pointerId: number, x: number, y: number) {
  pointer(window, "pointermove", pointerId, x, y);
  pointer(window, "pointerup", pointerId, x, y);
}
function tabs(count: number, title: (index: number) => string, first = "tab-0") {
  return Array.from({ length: count }, (_, position) => ({
    tabId: position ? `tab-${position}` : first,
    title: title(position),
    position,
    chatDock: "right" as const,
  }));
}
async function update(view: OpenClawBoardView, patch: Partial<BoardSnapshot>) {
  view.snapshot = { ...view.snapshot!, ...patch };
  await settle(view);
}

afterEach(() => {
  document.body.replaceChildren();
});

describe.skipIf(!hasBrowserLayout)("openclaw-board-view browser layout", () => {
  it("preserves vertical ancestor scroll when a board mounts or its tabs refresh", async () => {
    const parent = document.createElement("div");
    parent.style.cssText = "height: 120px; overflow-y: auto";
    const spacer = document.createElement("div");
    spacer.style.height = "600px";
    parent.append(spacer);
    document.body.append(parent);
    const view = await mount(undefined, parent);
    expect(parent.scrollTop).toBe(0);

    await update(view, {
      tabs: [...source.tabs, { tabId: "later", title: "Later", position: 2, chatDock: "right" }],
    });
    expect(parent.scrollTop).toBe(0);
  });

  it("keeps the overflow-selected tab visible without moving focus from More", async () => {
    const { page } = await import("vitest/browser");
    const view = await mount();
    view.style.width = "340px";
    view.snapshot = {
      ...structuredClone(source),
      tabs: tabs(8, (index) => `Research area ${index + 1}`),
      widgets: [],
    };
    view.activeTabId = "tab-0";
    view.callbacks = { ...view.callbacks!, selectTab: (tabId) => (view.activeTabId = tabId) };
    await view.updateComplete;
    const track = q<HTMLElement>(view, ".board-tabs__track");
    expect(track.scrollWidth).toBeGreaterThan(track.clientWidth);
    const trigger = q<HTMLButtonElement>(view, ".board-tabs__overflow-trigger");
    await page.elementLocator(trigger).click();
    await page.getByRole("menuitem", { name: "Research area 8", exact: true }).click();
    await vi.waitFor(() => {
      const selected = q<HTMLElement>(view, '[data-board-tab-id="tab-7"]');
      expect(selected.getAttribute("aria-selected")).toBe("true");
      const bounds = rect(track);
      const tab = rect(selected);
      expect(tab.left).toBeGreaterThanOrEqual(bounds.left - 1);
      expect(tab.right).toBeLessThanOrEqual(bounds.right + 1);
    });
    expect(document.activeElement).toBe(trigger);
    track.scrollLeft = 0;
    view.snapshot = { ...view.snapshot!, revision: 2 };
    await view.updateComplete;
    expect(track.scrollLeft).toBe(0);
  });

  it.each(["switch", "move"])("retains loaded widget state during %s", async (action) => {
    const view = await mount();
    const cell = cellsIn(view)[0]!;
    const frame = q<HTMLIFrameElement>(cell, "iframe");
    const messages: string[] = [];
    const receive = (event: MessageEvent) => {
      if (event.source === frame.contentWindow && typeof event.data?.tabState === "string") {
        messages.push(event.data.tabState);
      }
    };
    window.addEventListener("message", receive);
    onTestFinished(() => window.removeEventListener("message", receive));
    onTestFinished(({ task }) => {
      if (task.result?.state === "fail") {
        console.error("Board tab retention diagnostics", {
          messages: messages
            .slice(0, 16)
            .map((value) =>
              /^(ready|Last 30 days:[12])$/.test(value) ? value : "unexpected-state",
            ),
          connected: frame.isConnected,
          active: cell.active,
          loading: frame.loading,
          visibility: document.visibilityState,
          bounds: rect(frame).toJSON(),
        });
      }
    });
    frame.srcdoc = `<input value="All observations"><script>
        let visits = 0;
        addEventListener("message", ({ data }) => {
          if (data !== "visit") return;
          const input = document.querySelector("input");
          if (++visits === 1) input.value = "Last 30 days";
          parent.postMessage({ tabState: input.value + ":" + visits }, "*");
        });
        parent.postMessage({ tabState: "ready" }, "*");
      </script>`;
    await vi.waitFor(() => expect(messages).toEqual(["ready"]));
    frame.contentWindow!.postMessage("visit", "*");
    await vi.waitFor(() => expect(messages.at(-1)).toBe("Last 30 days:1"));

    view.callbacks = {
      ...view.callbacks!,
      applyOps: async (ops) => {
        view.snapshot = {
          ...view.snapshot!,
          ...applyBoardOps(view.snapshot!, ops),
          revision: view.snapshot!.revision + 1,
        };
      },
      selectTab: (tabId) => (view.activeTabId = tabId),
    };
    const switchTab = async (tabId: string) => {
      view
        .querySelector<HTMLButtonElement>(`.board-tabs__tab[data-board-tab-id="${tabId}"]`)!
        .click();
      await view.updateComplete;
      await cell.updateComplete;
    };
    if (action === "move") {
      const { page } = await import("vitest/browser");
      q<HTMLElement>(cell, ".board-widget").focus();
      await page.elementLocator(q(cell, ".board-widget__menu-trigger")).click();
      await page.elementLocator(q(cell, '[data-value="move:ops"]')).click();
      await vi.waitFor(() =>
        expect(view.snapshot?.widgets.find((widget) => widget.name === "first")?.tabId).toBe("ops"),
      );
      await view.updateComplete;
      await cell.updateComplete;
    } else {
      await switchTab("ops");
      expect(view.querySelector('[data-test-id="board-empty"]')).not.toBeNull();
    }
    expect(frame).toMatchObject({ isConnected: true });
    expect(cell).toMatchObject({ active: false, inert: true });
    expect(rect(frame).height).toBe(0);

    await switchTab(action === "move" ? "ops" : "main");
    expect(cell.querySelector("iframe")).toBe(frame);
    expect(cell.active).toBe(true);
    expect(rect(frame).height).toBeGreaterThan(0);
    frame.contentWindow!.postMessage("visit", "*");
    await vi.waitFor(() => expect(messages).toEqual(["ready", "Last 30 days:1", "Last 30 days:2"]));
  });

  it.each([354, 560])(
    "stacks a %ipx board without changing stored sizes or frame identity",
    async (width) => {
      const view = await mount();
      view.style.width = `${width}px`;
      const cells = cellsIn(view);
      const frames = cells.map((cell) => cell.querySelector("iframe"));
      const snapshot = structuredClone(source);
      snapshot.widgets[0]!.position = 1;
      snapshot.widgets[0]!.sizeH = 0;
      snapshot.widgets[1]!.position = 0;
      snapshot.widgets[1]!.heightMode = "fixed";
      view.snapshot = snapshot;
      await view.updateComplete;
      await Promise.all(cells.map((cell) => cell.updateComplete));
      const grid = q<HTMLElement>(view, ".board-grid").getBoundingClientRect();
      const [first, second] = cells.map((cell) => q(cell, "section").getBoundingClientRect());
      expect(first!.width).toBeCloseTo(grid.width, 0);
      expect(second!.width).toBeCloseTo(grid.width, 0);
      expect(first!.top).toBeGreaterThanOrEqual(second!.bottom + BOARD_GRID_GAP - 1);
      expect(first!.height).toBeGreaterThanOrEqual(BOARD_GRID_ROW_HEIGHT);
      expect(second!.height).toBe(BOARD_GRID_ROW_HEIGHT * 3 + BOARD_GRID_GAP * 2);
      expect(view.snapshot).toEqual(snapshot);
      expect([...view.querySelectorAll("openclaw-board-widget-cell")]).toEqual(cells);
      expect(cells.map((cell) => cell.querySelector("iframe"))).toEqual(frames);
      view.style.width = "1200px";
      expect(cells[0]!.querySelector("section")!.getBoundingClientRect().width).toBeLessThan(600);
    },
  );

  it("moves a narrow card onto the visible target's logical position", async () => {
    const applyOps = vi.fn(async () => undefined);
    const view = await mount(applyOps);
    view.style.width = "354px";
    const cards = [...view.querySelectorAll<HTMLElement>(".board-widget")];
    const target = rect(cards[0]!);
    pointer(cards[1]!.querySelector(".board-widget__drag-handle")!, "pointerdown", 81);
    pointer(window, "pointermove", 81, target.right - 3, target.top + target.height / 2);
    await settle(view);
    pointer(window, "pointerup", 81, target.right - 3, target.top + target.height / 2);
    await vi.waitFor(() =>
      expect(applyOps).toHaveBeenCalledWith([{ kind: "widget_move", name: "second", position: 0 }]),
    );
  });

  // A real outside focus target avoids platform-dependent blur() behavior.
  function focusSink(): HTMLButtonElement {
    const sink = document.createElement("button");
    sink.type = "button";
    document.body.append(sink);
    return sink;
  }

  function finishDocumentAnimations(): void {
    for (const animation of document.getAnimations()) {
      animation.finish();
    }
  }

  // Finish stalled headless transitions; a matching reveal selector remains visible.
  function expectChromeHidden(widget: HTMLElement, bar: HTMLElement): void {
    finishDocumentAnimations();
    const revealState = JSON.stringify({
      hover: widget.matches(":hover"),
      focusWithin: widget.matches(":focus-within"),
      dragging: widget.classList.contains("board-widget--dragging"),
      menuOpen: widget.querySelector('.board-widget__menu-trigger[aria-expanded="true"]') !== null,
    });
    expect(style(bar).visibility, revealState).toBe("hidden");
  }

  it("reveals widget chrome while the widget has focus", async () => {
    const view = await mount();
    view.style.width = "1200px";
    const sink = focusSink();
    const widget = view.querySelector<HTMLElement>('[data-test-id="board-widget"]');
    const bar = widget!.querySelector<HTMLElement>(".board-widget__bar");

    expect(style(bar!).visibility).toBe("hidden");
    expect(style(widget!.querySelector(".board-widget__resize-handle")!).visibility).toBe("hidden");
    widget!.focus();
    expect(style(bar!).visibility).toBe("visible");
    // Keep the centered pill clear of widget-owned corner actions.
    const barBounds = bar!.getBoundingClientRect();
    const widgetBounds = widget!.getBoundingClientRect();
    expect(barBounds.width).toBeLessThan(widgetBounds.width * 0.75);
    expect(barBounds.left + barBounds.width / 2).toBeCloseTo(
      widgetBounds.left + widgetBounds.width / 2,
      0,
    );

    sink.focus();
    expect(widget!.matches(":focus-within")).toBe(false);
    await vi.waitFor(() => expectChromeHidden(widget!, bar!));
  });

  it("scrolls a dense widget menu to Remove with End and activates it", async () => {
    const { userEvent } = await import("vitest/browser");
    const selected = createDeferred();
    const applyOps = vi.fn(async () => {
      selected.resolve();
      return undefined;
    });
    const view = await mount(applyOps);
    await update(view, {
      tabs: tabs(30, (index) => (index ? `Dashboard ${index + 1}` : "Main"), "main"),
      widgets: [source.widgets[0]!],
    });
    const cell = cellsIn(view)[0]!;
    q<HTMLElement>(cell, ".board-widget").focus();
    await userEvent.click(q<HTMLButtonElement>(cell, ".board-widget__menu-trigger"));
    const panel = q<HTMLElement>(cell, ".board-widget__menu-panel");
    expect(panel.scrollHeight).toBeGreaterThan(panel.clientHeight);

    await userEvent.keyboard("{End}");
    await Promise.resolve();
    const remove = q<HTMLButtonElement>(cell, ".board-widget__menu-danger");
    expect(document.activeElement).toBe(remove);
    const bounds = rect(panel);
    const row = rect(remove);
    expect(row.top).toBeGreaterThanOrEqual(bounds.top);
    expect(row.bottom).toBeLessThanOrEqual(bounds.bottom);
    expect(panel.scrollTop).toBeGreaterThan(0);

    await userEvent.keyboard("{Enter}");
    await selected.promise;
    expect(applyOps).toHaveBeenCalledWith([{ kind: "widget_remove", name: "first" }]);
  });
  it("keeps an active gesture owned by its initiating pointer", async () => {
    const applyOps = vi.fn(async () => undefined);
    const view = await mount(applyOps);
    const grid = view.querySelector<HTMLElement>(".board-grid");
    const handles = view.querySelectorAll<HTMLElement>(".board-widget__resize-handle");
    const gridBounds = grid!.getBoundingClientRect();
    const columnUnit = (gridBounds.width - BOARD_GRID_GAP * 11) / 12 + BOARD_GRID_GAP;
    pointer(handles[0]!, "pointerdown", 31, 100, 100);
    pointer(handles[1]!, "pointerdown", 32, 200, 100);
    pointer(
      window,
      "pointermove",
      32,
      200 + columnUnit,
      100 + BOARD_GRID_ROW_HEIGHT + BOARD_GRID_GAP,
    );
    pointer(window, "pointerup", 32);
    expect(applyOps).not.toHaveBeenCalled();

    dropAt(31, 100 + columnUnit, 100 + BOARD_GRID_ROW_HEIGHT + BOARD_GRID_GAP);
    await vi.waitFor(() =>
      expect(applyOps).toHaveBeenCalledWith([
        { kind: "widget_resize", name: "first", sizeW: 7, sizeH: 4, heightMode: "fixed" },
      ]),
    );
  });

  it("grows an auto-height card from its frame message and reflows its neighbor", async () => {
    const view = await mount();
    await update(view, {
      widgets: [
        { ...source.widgets[0]!, sizeW: 8 },
        { ...source.widgets[1]!, sizeW: 6, presentation: "frameless" },
      ],
    });
    const cells = [...view.querySelectorAll<HTMLElement>('[data-test-id="board-widget"]')];
    const first = cells[0]!;
    const second = cells[1]!;
    const frame = q<HTMLIFrameElement>(first, "iframe");
    const secondTopBefore = rect(second).top;

    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { type: "openclaw:widget-size", height: 300 },
      }),
    );
    // The card hugs its content (300px + 2x12px inset + 2px border); the
    // ceil-to-row slack stays outside the card as grid background.
    await vi.waitFor(() => expect(Math.round(rect(frame).height)).toBe(300));
    expect(Math.round(rect(first).height)).toBe(326);
    expect(rect(second).top).toBeGreaterThan(secondTopBefore);

    const cardBody = first.querySelector<HTMLElement>(".board-widget__body");
    expect(first.classList.contains("board-widget--card")).toBe(true);
    expect(style(cardBody!).paddingTop).toBe("12px");
    expect(second.classList.contains("board-widget--frameless")).toBe(true);
    // Other tests can leave the shared browser's pointer or focus over this widget.
    const { page } = await import("vitest/browser");
    await page.elementLocator(document.body).hover({ position: { x: 0, y: 0 } });
    focusSink().focus({ preventScroll: true });
    expect(second.matches(":hover")).toBe(false);
    expect(second.matches(":focus-within")).toBe(false);
    expect(style(second).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    finishDocumentAnimations();
    expect(style(second).borderTopColor).toBe("rgba(0, 0, 0, 0)");
    second.focus();
    finishDocumentAnimations();
    expect(style(second).borderTopColor).not.toBe("rgba(0, 0, 0, 0)");
  });

  it.each(
    (["card", "full-bleed", "frameless"] as const).flatMap((presentation) => [
      { presentation, surface: "grid" },
      { presentation, surface: "focused singleton" },
    ]),
  )(
    "keeps a $presentation widget stable in a $surface when its content fills the iframe viewport",
    async ({ presentation, surface }) => {
      const focused = surface === "focused singleton";
      const host = document.createElement("div");
      const parent = document.createElement("div");
      if (focused) {
        host.className = "sidebar-region sidebar-region--open sidebar-region--expanded";
        host.style.width = "1200px";
        parent.className = "board-session-surface__board";
        parent.style.height = "500px";
        host.append(parent);
        document.body.append(host);
      }
      const view = await mount(undefined, focused ? parent : document.body);
      await update(view, {
        ...(focused ? { tabs: [source.tabs[0]!] } : {}),
        widgets: [{ ...source.widgets[0]!, presentation, ...(focused ? { sizeW: 12 } : {}) }],
      });
      const cell = q(view, "openclaw-board-widget-cell");
      const frame = q(cell, "iframe");
      const initialHeight = rect(frame).height;
      const reports: number[] = [];
      const ready = createDeferred();
      const recordSize = (event: MessageEvent) => {
        if (event.source !== frame.contentWindow) {
          return;
        }
        if (event.data?.type === "openclaw:widget-bridge-ready") {
          ready.resolve();
        }
        if (event.data?.type === "openclaw:widget-size") {
          reports.push(event.data.height);
        }
      };
      window.addEventListener("message", recordSize);
      onTestFinished(() => window.removeEventListener("message", recordSize));
      frame.srcdoc = buildWidgetDocument(
        "Viewport-sized dashboard",
        "<style>body{min-height:100vh}</style><main>Dashboard content</main>",
      );
      // Wait for bridge readiness, not merely the srcdoc assignment.
      await ready.promise;
      await vi.waitFor(() => expect(reports.length).toBeGreaterThan(0));
      for (const expanded of focused ? [true, false, true] : [false]) {
        if (focused) {
          host.classList.toggle("sidebar-region--expanded", expanded);
        }
        // Exercise repeated report/layout cycles after every host resize.
        for (let index = 0; index < 12; index += 1) {
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          });
        }
        expect(rect(frame).height).toBeCloseTo(initialHeight, 0);
        expect(reports.every((height) => height === initialHeight)).toBe(true);
        expect(view.querySelector("iframe")).toBe(frame);
        if (focused) {
          const widget = q<HTMLElement>(cell, ".board-widget");
          const body = q<HTMLElement>(cell, ".board-widget__body");
          expect(style(widget).borderTopWidth).toBe(expanded ? "0px" : "1px");
          expect(style(body).paddingTop).toBe(presentation === "card" ? "12px" : "0px");
          if (expanded) {
            expect(style(widget).borderRadius).toBe("0px");
            expect(style(body).borderRadius).toBe("0px");
            const bounds = rect(frame);
            const available = rect(parent);
            const inset = presentation === "card" ? 12 : 0;
            expect(bounds.left).toBeCloseTo(available.left + inset, 0);
            expect(bounds.top).toBeCloseTo(available.top + inset, 0);
            expect(bounds.right).toBeCloseTo(available.right - inset, 0);
          }
        }
      }
    },
  );

  it("rejects tab drop targets owned by another board", async () => {
    const applyOps = vi.fn(async () => undefined);
    const view = await mount(applyOps);

    const other = await mount();
    other.snapshot = {
      ...structuredClone(source),
      tabs: [
        { tabId: "foreign-a", title: "Foreign A", position: 0, chatDock: "right" },
        { tabId: "foreign-b", title: "Foreign B", position: 1, chatDock: "right" },
      ],
      widgets: [],
    };
    other.activeTabId = "foreign-a";
    await other.updateComplete;

    const handle = view.querySelector<HTMLElement>(".board-widget__drag-handle");
    const foreignTab = other.querySelector<HTMLElement>('[data-board-tab-id="foreign-b"]');
    const target = foreignTab!.getBoundingClientRect();
    pointer(handle!, "pointerdown", 41, 100, 100);
    dropAt(41, target.left + target.width / 2, target.top + target.height / 2);
    await Promise.resolve();
    expect(applyOps).not.toHaveBeenCalled();
  });

  it("rejects widget drops outside the board grid", async () => {
    const applyOps = vi.fn(async () => undefined);
    const view = await mount(applyOps);
    const handle = view.querySelector<HTMLElement>(".board-widget__drag-handle");
    pointer(handle!, "pointerdown", 51, 100, 100);
    dropAt(51, 0, 10_000);
    await Promise.resolve();
    expect(applyOps).not.toHaveBeenCalled();
  });

  it.each([354, 700])("offers an append drop zone on a %ipx board", async (width) => {
    const applyOps = vi.fn(async () => undefined);
    const view = await mount(applyOps);
    view.style.width = `${width}px`;
    await update(view, {
      widgets: source.widgets.map((widget) => ({ ...widget, sizeW: 12 })),
    });
    const handle = view.querySelector<HTMLElement>(".board-widget__drag-handle");
    pointer(handle!, "pointerdown", 61, 100, 100);
    await view.updateComplete;
    const appendZone = view.querySelector<HTMLElement>(".board-grid__append-zone");
    const target = appendZone!.getBoundingClientRect();
    const targetX = target.left + target.width / 2;
    const targetY = target.top + target.height / 2;
    dropAt(61, targetX, targetY);
    await vi.waitFor(() =>
      expect(applyOps).toHaveBeenCalledWith([{ kind: "widget_move", name: "first", position: 1 }]),
    );
  });

  it("keeps approval controls scrollable in a one-row widget", async () => {
    const view = await mount();
    await update(view, {
      widgets: [{ ...source.widgets[0]!, sizeH: 1, grantState: "pending" }],
    });
    const body = view.querySelector<HTMLElement>(".board-widget__body--scrollable");
    const allow = view.querySelector<HTMLButtonElement>('[data-test-id="board-grant-allow"]');
    expect(style(body!).overflowY).toBe("auto");
    expect(body!.scrollHeight).toBeGreaterThan(body!.clientHeight);
    allow?.focus();
    expect(document.activeElement).toBe(allow);
  });
});
