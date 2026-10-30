import { afterEach, describe, expect, it, vi } from "vitest";
import { exactBoardWidgetHeightPx, FINE_POINTER_QUERY } from "../../lib/board/grid.ts";
import "./board-view.tsx";
import { createMediaQueryList } from "../../test-helpers/media-query.ts";
import { boardWidget, mount, openBoardMenu, widgetSnapshot } from "./board-view.test-support.ts";

afterEach(() => vi.restoreAllMocks());

const resizeOp = (sizeW: number, sizeH: number, heightMode: "auto" | "fixed") => ({
  kind: "widget_resize",
  name: "alpha",
  sizeW,
  sizeH,
  heightMode,
});
const menuItem = (view: ParentNode, value: string) =>
  view.querySelector<HTMLButtonElement>(`[data-value="${value}"]`)!;

describe("board widget sizing", () => {
  it("hugs auto cards to their exact content height inside the quantized cell", () => {
    const card = boardWidget({ sizeH: 6 });
    expect(exactBoardWidgetHeightPx(card, 300)).toBe(326);
    expect(exactBoardWidgetHeightPx({ ...card, presentation: "frameless" }, 300)).toBe(302);
    expect(exactBoardWidgetHeightPx(card, 60)).toBe(86);
    expect(exactBoardWidgetHeightPx(card, 10_000)).toBe(20 * 56 + 19 * 12);
    expect(exactBoardWidgetHeightPx(card, 10_000, 0, 240)).toBe(10_026);
    expect(exactBoardWidgetHeightPx(card, 300, 38)).toBe(364);
    expect(exactBoardWidgetHeightPx({ ...card, heightMode: "fixed" }, 300)).toBeUndefined();
    expect(exactBoardWidgetHeightPx(card, undefined)).toBeUndefined();
    expect(exactBoardWidgetHeightPx({ ...card, contentKind: "mcp-app" }, 300)).toBeUndefined();
  });

  it("lets a dashboard document fit tall HTML content without an inner scroll viewport", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation((media) =>
      createMediaQueryList(media, media === FINE_POINTER_QUERY),
    );
    const view = await mount();
    view.fitAutoContent = true;
    await view.updateComplete;
    const cell = view.querySelector("openclaw-board-widget-cell")!;
    window.dispatchEvent(
      new MessageEvent("message", {
        source: cell.querySelector("iframe")?.contentWindow ?? null,
        data: { type: "openclaw:widget-size", height: 10_000 },
      }),
    );

    await vi.waitFor(() => {
      const style = cell.querySelector(".board-widget")?.getAttribute("style");
      expect(style).toContain("height: calc(10026px - var(--board-widget-height-trim, 0px))");
      expect(style).toContain("span 148");
    });
  });

  it("pins preset resizing and toggles height mode from the menu", async () => {
    const view = await mount();
    const applyOps = view.callbacks!.applyOps;
    expect(view.querySelector('[role^="menuitem"]')).toBeNull();
    await openBoardMenu(view);
    menuItem(view, "resize:sm").click();
    await vi.waitFor(() => expect(applyOps).toHaveBeenCalledWith([resizeOp(3, 3, "fixed")]));
    const cell = view.querySelector("openclaw-board-widget-cell");
    await vi.waitFor(() =>
      expect(cell?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.disabled).toBe(false),
    );

    await openBoardMenu(view);
    menuItem(view, "height:auto").click();
    await vi.waitFor(() => expect(applyOps).toHaveBeenLastCalledWith([resizeOp(6, 4, "fixed")]));
  });

  it("returns a pinned widget to automatic height from the menu", async () => {
    const view = await mount({ snapshot: widgetSnapshot({ heightMode: "fixed" }) });
    const applyOps = view.callbacks!.applyOps;
    await openBoardMenu(view);
    const auto = menuItem(view, "height:auto");
    expect(auto.getAttribute("aria-checked")).toBe("false");
    auto.click();
    await vi.waitFor(() => expect(applyOps).toHaveBeenLastCalledWith([resizeOp(6, 4, "auto")]));
  });
});
