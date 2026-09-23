import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBoardOps } from "../../../../src/boards/board-layout.js";
import { buildWidgetDocument } from "../../../../src/canvas/wrap.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { BOARD_GRID_GAP, BOARD_GRID_ROW_HEIGHT } from "../../lib/board/grid.ts";
import type { BoardSnapshot } from "../../lib/board/types.ts";
import "../../styles/base.css";
import "../../styles/chat/board.css";
import "./board-view.ts";

type OpenClawBoardView = HTMLElementTagNameMap["openclaw-board-view"];

const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");

const source: BoardSnapshot = {
  sessionKey: "agent:main:browser-board",
  revision: 1,
  tabs: [
    { tabId: "main", title: "Main", position: 0, chatDock: "right" },
    { tabId: "ops", title: "Operations", position: 1, chatDock: "right" },
  ],
  widgets: [
    {
      name: "first",
      tabId: "main",
      title: "First",
      contentKind: "html",
      sizeW: 6,
      sizeH: 3,
      position: 0,
      grantState: "none",
      revision: 1,
    },
    {
      name: "second",
      tabId: "main",
      title: "Second",
      contentKind: "html",
      sizeW: 6,
      sizeH: 3,
      position: 1,
      grantState: "none",
      revision: 1,
    },
  ],
};

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
  await view.updateComplete;
  await Promise.all(
    [...view.querySelectorAll("openclaw-board-widget-cell")].map((cell) => cell.updateComplete),
  );
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

afterEach(() => {
  document.body.replaceChildren();
});

describe.skipIf(!hasBrowserLayout)("openclaw-board-view browser layout", () => {
  it.each(["switch", "move"])("retains loaded widget state during %s", async (action) => {
    const view = await mount();
    const cell = view.querySelector("openclaw-board-widget-cell")!;
    const frame = cell.querySelector("iframe")!;
    const messages: string[] = [];
    const fixtureStates = new Set(["ready", "Last 30 days:1", "Last 30 days:2"]);
    const loggedState = (value: string) => (fixtureStates.has(value) ? value : "unexpected-state");
    const startedAt = performance.timeOrigin + performance.now();
    const timeline: {
      phase: string;
      elapsedMs: number;
      visibility: DocumentVisibilityState;
      state?: string;
      sourceMatches?: boolean;
      emittedAtMs?: number;
    }[] = [];
    const record = (
      phase: string,
      detail: { state?: string; sourceMatches?: boolean; emittedAtMs?: number } = {},
    ) => {
      if (timeline.length >= 16) {
        return;
      }
      timeline.push({
        phase,
        elapsedMs: performance.timeOrigin + performance.now() - startedAt,
        visibility: document.visibilityState,
        ...detail,
      });
    };
    const loaded = () => record("iframe-load");
    frame.addEventListener("load", loaded);
    const receive = (event: MessageEvent) => {
      if (typeof event.data?.tabState === "string") {
        record("message", {
          state: loggedState(event.data.tabState),
          sourceMatches: event.source === frame.contentWindow,
          emittedAtMs:
            typeof event.data.emittedAt === "number" ? event.data.emittedAt - startedAt : undefined,
        });
      }
      if (event.source === frame.contentWindow && typeof event.data?.tabState === "string") {
        messages.push(event.data.tabState);
      }
    };
    window.addEventListener("message", receive);
    record("listener-registered");
    try {
      record("assign-srcdoc");
      frame.srcdoc = `<input value="All observations"><script>
        let visits = 0;
        addEventListener("message", ({ data }) => {
          if (data !== "visit") return;
          const input = document.querySelector("input");
          if (++visits === 1) input.value = "Last 30 days";
          parent.postMessage({ tabState: input.value + ":" + visits }, "*");
        });
        parent.postMessage({ tabState: "ready", emittedAt: performance.timeOrigin + performance.now() }, "*");
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
          .querySelector(".board-tabs__track")!
          .dispatchEvent(
            new CustomEvent("wa-tab-show", { detail: { name: tabId }, bubbles: true }),
          );
        await view.updateComplete;
        await cell.updateComplete;
      };
      if (action === "move") {
        const { page } = await import("vitest/browser");
        cell.querySelector<HTMLElement>(".board-widget")!.focus();
        await page.elementLocator(cell.querySelector(".board-widget__menu-trigger")!).click();
        await page
          .elementLocator(cell.querySelector('wa-dropdown-item[value="move:ops"]')!)
          .click();
        await vi.waitFor(() =>
          expect(view.snapshot?.widgets.find((widget) => widget.name === "first")?.tabId).toBe(
            "ops",
          ),
        );
        await view.updateComplete;
        await cell.updateComplete;
      } else {
        await switchTab("ops");
        expect(view.querySelector('[data-test-id="board-empty"]')).not.toBeNull();
      }
      expect(frame.isConnected).toBe(true);
      expect(cell.active).toBe(false);
      expect(cell.inert).toBe(true);
      expect(frame.getBoundingClientRect().height).toBe(0);

      await switchTab(action === "move" ? "ops" : "main");
      expect(cell.querySelector("iframe")).toBe(frame);
      expect(cell.active).toBe(true);
      expect(frame.getBoundingClientRect().height).toBeGreaterThan(0);
      frame.contentWindow!.postMessage("visit", "*");
      await vi.waitFor(() =>
        expect(messages).toEqual(["ready", "Last 30 days:1", "Last 30 days:2"]),
      );
    } catch (error) {
      record("failure");
      console.error(
        "Board tab retention diagnostics",
        JSON.stringify({
          timeline,
          messages: messages.map(loggedState),
          connected: frame.isConnected,
          active: cell.active,
          loading: frame.loading,
          // Read geometry only after failure so diagnostics cannot trigger initial layout.
          bounds: frame.getBoundingClientRect().toJSON(),
          viewport: { width: innerWidth, height: innerHeight },
        }),
      );
      throw error;
    } finally {
      frame.removeEventListener("load", loaded);
      window.removeEventListener("message", receive);
    }
  });

  it("lays out adjacent first-fit cells without pixel overlap", async () => {
    const view = await mount();
    view.style.width = "1200px";
    const cells = [...view.querySelectorAll<HTMLElement>('[data-test-id="board-widget"]')];
    expect(cells).toHaveLength(2);
    const [first, second] = cells.map((cell) => cell.getBoundingClientRect());
    expect(first?.width).toBeGreaterThan(0);
    expect(second?.left).toBeGreaterThanOrEqual((first?.right ?? 0) + BOARD_GRID_GAP - 1);
    expect(Math.round(first?.height ?? 0)).toBe(BOARD_GRID_ROW_HEIGHT * 3 + BOARD_GRID_GAP * 2);
  });

  it.each([354, 560])(
    "stacks a %ipx board without changing stored sizes or frame identity",
    async (width) => {
      const view = await mount();
      view.style.width = `${width}px`;
      const cells = [...view.querySelectorAll("openclaw-board-widget-cell")];
      const frames = cells.map((cell) => cell.querySelector("iframe"));
      const snapshot = structuredClone(source);
      snapshot.widgets[0]!.position = 1;
      snapshot.widgets[0]!.sizeH = 0;
      snapshot.widgets[1]!.position = 0;
      snapshot.widgets[1]!.heightMode = "fixed";
      view.snapshot = snapshot;
      await view.updateComplete;
      await Promise.all(cells.map((cell) => cell.updateComplete));
      const grid = view.querySelector<HTMLElement>(".board-grid")!.getBoundingClientRect();
      const [first, second] = cells.map((cell) =>
        cell.querySelector("section")!.getBoundingClientRect(),
      );
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
    const target = cards[0]!.getBoundingClientRect();
    pointer(cards[1]!.querySelector(".board-widget__drag-handle")!, "pointerdown", 81);
    pointer(window, "pointermove", 81, target.right - 3, target.top + target.height / 2);
    await view.updateComplete;
    await Promise.all(
      [...view.querySelectorAll("openclaw-board-widget-cell")].map((cell) => cell.updateComplete),
    );
    pointer(window, "pointerup", 81, target.right - 3, target.top + target.height / 2);
    await vi.waitFor(() =>
      expect(applyOps).toHaveBeenCalledWith([{ kind: "widget_move", name: "second", position: 0 }]),
    );
  });

  it("hides widget chrome by default on fine-pointer devices", async () => {
    const view = await mount();
    const bar = view.querySelector<HTMLElement>(".board-widget__bar");
    const handle = view.querySelector<HTMLElement>(".board-widget__resize-handle");
    expect(getComputedStyle(bar!).visibility).toBe("hidden");
    expect(getComputedStyle(handle!).visibility).toBe("hidden");
  });

  // Chrome must stay revealed while focus is anywhere inside the cell (menu
  // close restores focus to its trigger), so hiding is proven by moving focus
  // to an outside sink rather than blur(), which leaves focus placement to the
  // platform and flakes on Linux.
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

  // Headless CI renderers can stall the animation timeline, leaving the 120ms
  // hide transition permanently mid-flight; finishing transitions asserts the
  // target visibility state instead of the renderer's clock. A genuinely
  // matching reveal selector still fails: its finished end state is visible.
  function expectChromeHidden(widget: HTMLElement, bar: HTMLElement): void {
    finishDocumentAnimations();
    const revealState = JSON.stringify({
      hover: widget.matches(":hover"),
      focusWithin: widget.matches(":focus-within"),
      dragging: widget.classList.contains("board-widget--dragging"),
      menuOpen: widget.querySelector(".board-widget__menu[open]") !== null,
    });
    expect(getComputedStyle(bar).visibility, revealState).toBe("hidden");
  }

  it("reveals widget chrome while the widget has focus", async () => {
    const view = await mount();
    view.style.width = "1200px";
    const sink = focusSink();
    const widget = view.querySelector<HTMLElement>('[data-test-id="board-widget"]');
    const bar = widget!.querySelector<HTMLElement>(".board-widget__bar");

    widget!.focus();
    expect(getComputedStyle(bar!).visibility).toBe("visible");
    // Chrome is a compact centered pill, not a full-width strip: it must not
    // stretch across the card, so widget-owned corner actions stay clear.
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

  it("compacts centered chrome at intermediate widths", async () => {
    const view = await mount();
    view.style.width = "700px";
    view.snapshot = {
      ...structuredClone(source),
      widgets: [
        {
          ...source.widgets[0]!,
          sizeW: 6,
          title: "An extremely long widget title that wants the whole bar",
          grantState: "granted",
        },
      ],
    };
    await view.updateComplete;
    const cell = view.querySelector("openclaw-board-widget-cell");
    await cell?.updateComplete;
    const widget = view.querySelector<HTMLElement>('[data-test-id="board-widget"]');
    const bar = widget!.querySelector<HTMLElement>(".board-widget__bar");
    widget!.focus();
    expect(getComputedStyle(bar!).visibility).toBe("visible");
    const widgetBounds = widget!.getBoundingClientRect();
    const barBounds = bar!.getBoundingClientRect();
    expect(widgetBounds.width).toBeGreaterThan(264);
    expect(widgetBounds.width).toBeLessThanOrEqual(376);
    expect(barBounds.left + barBounds.width / 2).toBeCloseTo(
      widgetBounds.left + widgetBounds.width / 2,
      0,
    );
    expect(barBounds.left - widgetBounds.left).toBeGreaterThanOrEqual(88);
    expect(widgetBounds.right - barBounds.right).toBeGreaterThanOrEqual(88);
    for (const selector of [".board-widget__title", ".board-widget__kind"]) {
      expect(getComputedStyle(bar!.querySelector<HTMLElement>(selector)!).display).toBe("none");
    }
    for (const child of bar!.children) {
      expect(child.getBoundingClientRect().right).toBeLessThanOrEqual(
        bar!.getBoundingClientRect().right + 1,
      );
    }
  });

  it("strips the pill to move + menu on widgets too narrow for the reservation", async () => {
    const view = await mount();
    view.style.width = "700px";
    view.snapshot = {
      ...structuredClone(source),
      widgets: [
        {
          ...source.widgets[0]!,
          sizeW: 3,
          title: "An extremely long widget title that wants the whole bar",
          grantState: "granted",
        },
      ],
    };
    await view.updateComplete;
    const cell = view.querySelector("openclaw-board-widget-cell");
    await cell?.updateComplete;
    const widget = view.querySelector<HTMLElement>('[data-test-id="board-widget"]');
    const bar = widget!.querySelector<HTMLElement>(".board-widget__bar");
    widget!.focus();
    expect(getComputedStyle(bar!).visibility).toBe("visible");
    // Very narrow cards keep the irreducible move + menu pair while the rest of
    // the card stays widget-owned.
    expect(widget!.getBoundingClientRect().width).toBeLessThan(184);
    const title = bar!.querySelector<HTMLElement>(".board-widget__title");
    const kind = bar!.querySelector<HTMLElement>(".board-widget__kind");
    expect(getComputedStyle(title!).display).toBe("none");
    expect(getComputedStyle(kind!).display).toBe("none");
    const widgetBounds = widget!.getBoundingClientRect();
    const barBounds = bar!.getBoundingClientRect();
    expect(barBounds.width).toBeLessThanOrEqual(76);
    expect(barBounds.left - widgetBounds.left).toBeLessThan(widgetBounds.right - barBounds.right);
  });

  it("keeps widget chrome visible while its menu is open", async () => {
    const { userEvent } = await import("vitest/browser");
    const view = await mount();
    const sink = focusSink();
    const widget = view.querySelector<HTMLElement>('[data-test-id="board-widget"]');
    const bar = widget!.querySelector<HTMLElement>(".board-widget__bar");
    const menu = widget!.querySelector<HTMLElement & { open: boolean }>(".board-widget__menu");

    menu!.open = true;
    await vi.waitFor(() => expect(getComputedStyle(bar!).visibility).toBe("visible"));

    menu!.open = false;
    await userEvent.unhover(widget!);
    sink.focus();
    expect(widget!.matches(":focus-within")).toBe(false);
    await vi.waitFor(() => expectChromeHidden(widget!, bar!));
  });

  it("snaps pointer resize to columns and rows before committing", async () => {
    const applyOps = vi.fn(async () => undefined);
    const view = await mount(applyOps);
    const grid = view.querySelector<HTMLElement>(".board-grid");
    const handle = view.querySelector<HTMLElement>(".board-widget__resize-handle");
    expect(grid).not.toBeNull();
    expect(handle).not.toBeNull();
    const gridBounds = grid!.getBoundingClientRect();
    const columnUnit = (gridBounds.width - BOARD_GRID_GAP * 11) / 12 + BOARD_GRID_GAP;
    pointer(handle!, "pointerdown", 19, 100, 100);
    pointer(
      window,
      "pointermove",
      19,
      100 + columnUnit,
      100 + BOARD_GRID_ROW_HEIGHT + BOARD_GRID_GAP,
    );
    pointer(
      window,
      "pointerup",
      19,
      100 + columnUnit * 2,
      100 + (BOARD_GRID_ROW_HEIGHT + BOARD_GRID_GAP) * 2,
    );

    await vi.waitFor(() =>
      expect(applyOps).toHaveBeenCalledWith([
        { kind: "widget_resize", name: "first", sizeW: 8, sizeH: 5, heightMode: "fixed" },
      ]),
    );
  });

  it("does not commit pointer gestures that never change placement", async () => {
    const applyOps = vi.fn(async () => undefined);
    const view = await mount(applyOps);
    const handle = view.querySelector<HTMLElement>(".board-widget__resize-handle");
    pointer(handle!, "pointerdown", 23, 100, 100);
    pointer(window, "pointerup", 23, 100, 100);
    const dragHandle = view.querySelector<HTMLElement>(".board-widget__drag-handle");
    pointer(dragHandle!, "pointerdown", 24, 100, 100);
    pointer(window, "pointerup", 24, 100, 100);
    await Promise.resolve();
    expect(applyOps).not.toHaveBeenCalled();
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

    pointer(
      window,
      "pointermove",
      31,
      100 + columnUnit,
      100 + BOARD_GRID_ROW_HEIGHT + BOARD_GRID_GAP,
    );
    pointer(
      window,
      "pointerup",
      31,
      100 + columnUnit,
      100 + BOARD_GRID_ROW_HEIGHT + BOARD_GRID_GAP,
    );
    await vi.waitFor(() =>
      expect(applyOps).toHaveBeenCalledWith([
        { kind: "widget_resize", name: "first", sizeW: 7, sizeH: 4, heightMode: "fixed" },
      ]),
    );
  });

  it("grows an auto-height card from its frame message and reflows its neighbor", async () => {
    const view = await mount();
    view.snapshot = {
      ...structuredClone(source),
      widgets: [
        { ...source.widgets[0]!, sizeW: 8 },
        { ...source.widgets[1]!, sizeW: 6, presentation: "frameless" },
      ],
    };
    await view.updateComplete;
    await Promise.all(
      [...view.querySelectorAll("openclaw-board-widget-cell")].map((cell) => cell.updateComplete),
    );
    const cells = [...view.querySelectorAll<HTMLElement>('[data-test-id="board-widget"]')];
    const first = cells[0]!;
    const second = cells[1]!;
    const frame = first.querySelector<HTMLIFrameElement>("iframe")!;
    const secondTopBefore = second.getBoundingClientRect().top;

    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { type: "openclaw:widget-size", height: 300 },
      }),
    );
    // The card hugs its content (300px + 2x12px inset + 2px border); the
    // ceil-to-row slack stays outside the card as grid background.
    await vi.waitFor(() => expect(Math.round(frame.getBoundingClientRect().height)).toBe(300));
    expect(Math.round(first.getBoundingClientRect().height)).toBe(326);
    expect(second.getBoundingClientRect().top).toBeGreaterThan(secondTopBefore);

    const cardBody = first.querySelector<HTMLElement>(".board-widget__body");
    expect(first.classList.contains("board-widget--card")).toBe(true);
    expect(getComputedStyle(cardBody!).paddingTop).toBe("12px");
    expect(second.classList.contains("board-widget--frameless")).toBe(true);
    // Other tests can leave the shared browser's pointer or focus over this widget.
    const { page } = await import("vitest/browser");
    await page.elementLocator(document.body).hover({ position: { x: 0, y: 0 } });
    focusSink().focus({ preventScroll: true });
    expect(second.matches(":hover")).toBe(false);
    expect(second.matches(":focus-within")).toBe(false);
    expect(getComputedStyle(second).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    finishDocumentAnimations();
    expect(getComputedStyle(second).borderTopColor).toBe("rgba(0, 0, 0, 0)");
    second.focus();
    finishDocumentAnimations();
    expect(getComputedStyle(second).borderTopColor).not.toBe("rgba(0, 0, 0, 0)");
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
      view.snapshot = {
        ...structuredClone(source),
        ...(focused ? { tabs: [source.tabs[0]!] } : {}),
        widgets: [{ ...source.widgets[0]!, presentation, ...(focused ? { sizeW: 12 } : {}) }],
      };
      await view.updateComplete;
      const cell = view.querySelector("openclaw-board-widget-cell")!;
      await cell.updateComplete;
      const frame = cell.querySelector("iframe")!;
      const initialHeight = frame.getBoundingClientRect().height;
      const reports: number[] = [];
      const ready = createDeferred();
      const recordSize = (event: MessageEvent) => {
        if (
          event.source === frame.contentWindow &&
          event.data?.type === "openclaw:widget-bridge-ready"
        ) {
          ready.resolve();
        }
        if (event.source === frame.contentWindow && event.data?.type === "openclaw:widget-size") {
          reports.push(event.data.height);
        }
      };
      window.addEventListener("message", recordSize);
      try {
        frame.srcdoc = buildWidgetDocument(
          "Viewport-sized dashboard",
          "<style>body{min-height:100vh}</style><main>Dashboard content</main>",
        );
        // Start the size-report check after this document's bridge is running;
        // assigning srcdoc does not mean Chromium has started the navigation.
        await ready.promise;
        await vi.waitFor(() => expect(reports.length).toBeGreaterThan(0));
        for (const expanded of focused ? [true, false, true] : [false]) {
          if (focused) {
            host.classList.toggle("sidebar-region--expanded", expanded);
          }
          // Each host resize can trigger another content report; allow repeated
          // layout cycles so changing the shell cannot shrink or grow the frame.
          for (let index = 0; index < 12; index += 1) {
            await new Promise<void>((resolve) => {
              requestAnimationFrame(() => resolve());
            });
          }
          expect(frame.getBoundingClientRect().height).toBeCloseTo(initialHeight, 0);
          expect(reports.every((height) => height === initialHeight)).toBe(true);
          expect(view.querySelector("iframe")).toBe(frame);
          if (focused) {
            const widget = cell.querySelector<HTMLElement>(".board-widget")!;
            const body = cell.querySelector<HTMLElement>(".board-widget__body")!;
            expect(getComputedStyle(widget).borderTopWidth).toBe(expanded ? "0px" : "1px");
            expect(getComputedStyle(body).paddingTop).toBe(
              !expanded && presentation === "card" ? "12px" : "0px",
            );
            if (expanded) {
              expect(getComputedStyle(widget).borderRadius).toBe("0px");
              expect(getComputedStyle(body).borderRadius).toBe("0px");
              const bounds = frame.getBoundingClientRect();
              const available = parent.getBoundingClientRect();
              expect(bounds.left).toBeCloseTo(available.left, 0);
              expect(bounds.top).toBeCloseTo(available.top, 0);
              expect(bounds.right).toBeCloseTo(available.right, 0);
            }
          }
        }
      } finally {
        window.removeEventListener("message", recordSize);
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
    pointer(
      window,
      "pointermove",
      41,
      target.left + target.width / 2,
      target.top + target.height / 2,
    );
    pointer(
      window,
      "pointerup",
      41,
      target.left + target.width / 2,
      target.top + target.height / 2,
    );
    await Promise.resolve();
    expect(applyOps).not.toHaveBeenCalled();
  });

  it("rejects widget drops outside the board grid", async () => {
    const applyOps = vi.fn(async () => undefined);
    const view = await mount(applyOps);
    const handle = view.querySelector<HTMLElement>(".board-widget__drag-handle");
    pointer(handle!, "pointerdown", 51, 100, 100);
    pointer(window, "pointermove", 51, 0, 10_000);
    pointer(window, "pointerup", 51, 0, 10_000);
    await Promise.resolve();
    expect(applyOps).not.toHaveBeenCalled();
  });

  it.each([354, 700])("offers an append drop zone on a %ipx board", async (width) => {
    const applyOps = vi.fn(async () => undefined);
    const view = await mount(applyOps);
    view.style.width = `${width}px`;
    view.snapshot = {
      ...structuredClone(source),
      widgets: source.widgets.map((widget) => ({ ...widget, sizeW: 12 })),
    };
    await view.updateComplete;
    const cells = view.querySelectorAll("openclaw-board-widget-cell");
    await Promise.all([...cells].map((cell) => cell.updateComplete));
    const handle = view.querySelector<HTMLElement>(".board-widget__drag-handle");
    pointer(handle!, "pointerdown", 61, 100, 100);
    await view.updateComplete;
    const appendZone = view.querySelector<HTMLElement>(".board-grid__append-zone");
    const target = appendZone!.getBoundingClientRect();
    const targetX = target.left + target.width / 2;
    const targetY = target.top + target.height / 2;
    pointer(window, "pointermove", 61, targetX, targetY);
    pointer(window, "pointerup", 61, targetX, targetY);
    await vi.waitFor(() =>
      expect(applyOps).toHaveBeenCalledWith([{ kind: "widget_move", name: "first", position: 1 }]),
    );
  });

  it("keeps approval controls scrollable in a one-row widget", async () => {
    const view = await mount();
    view.snapshot = {
      ...structuredClone(source),
      widgets: [{ ...source.widgets[0]!, sizeH: 1, grantState: "pending" }],
    };
    await view.updateComplete;
    const cell = view.querySelector("openclaw-board-widget-cell");
    await cell?.updateComplete;
    const body = view.querySelector<HTMLElement>(".board-widget__body--scrollable");
    const allow = view.querySelector<HTMLButtonElement>('[data-test-id="board-grant-allow"]');
    expect(getComputedStyle(body!).overflowY).toBe("auto");
    expect(body!.scrollHeight).toBeGreaterThan(body!.clientHeight);
    allow?.focus();
    expect(document.activeElement).toBe(allow);
  });

  it("keeps contained errors scrollable in a one-row widget", async () => {
    const view = await mount();
    view.snapshot = {
      ...structuredClone(source),
      widgets: [{ ...source.widgets[0]!, sizeH: 1 }],
    };
    view.widgetFrameUrl = () => {
      throw new Error("one-row resolver failed");
    };
    await view.updateComplete;
    const cell = view.querySelector("openclaw-board-widget-cell");
    await cell?.updateComplete;
    const body = view.querySelector<HTMLElement>(".board-widget__body--scrollable");
    expect(getComputedStyle(body!).overflowY).toBe("auto");
    expect(body!.scrollHeight).toBeGreaterThan(body!.clientHeight);
    expect(body?.textContent).toContain("one-row resolver failed");
  });
});
