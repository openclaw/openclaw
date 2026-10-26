import { afterEach, describe, expect, it, vi } from "vitest";
import { exactBoardWidgetHeightPx, FINE_POINTER_QUERY } from "../../lib/board/grid.ts";
import "./board-view.tsx";
import { createMediaQueryList } from "../../test-helpers/media-query.ts";
import {
  boardWidget,
  callbacks,
  mount,
  openBoardMenu,
  snapshot,
} from "./board-view.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const resizeOp = (sizeW: number, sizeH: number, heightMode: "auto" | "fixed") => ({
  kind: "widget_resize",
  name: "alpha",
  sizeW,
  sizeH,
  heightMode,
});

describe("board widget sizing", () => {
  it("hugs auto cards to their exact content height inside the quantized cell", () => {
    const card = boardWidget({ sizeH: 6 });
    // Borders + card padding; short content hugs below the cell minimum.
    expect(exactBoardWidgetHeightPx(card, 300)).toBe(326);
    expect(exactBoardWidgetHeightPx({ ...card, presentation: "frameless" }, 300)).toBe(302);
    expect(exactBoardWidgetHeightPx(card, 60)).toBe(86);
    // Normal boards cap at 20 rows; documents can raise the cap.
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
    const cell = view.querySelector("openclaw-board-widget-cell");
    const frame = cell?.querySelector("iframe");
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame?.contentWindow ?? null,
        data: { type: "openclaw:widget-size", height: 10_000 },
      }),
    );

    await vi.waitFor(() => {
      const section = cell?.querySelector<HTMLElement>(".board-widget");
      expect(section?.getAttribute("style")).toContain(
        "height: calc(10026px - var(--board-widget-height-trim, 0px))",
      );
      expect(section?.getAttribute("style")).toContain("span 148");
    });
  });

  it("pins preset resizing and toggles height mode from the menu", async () => {
    const applyOps = vi.fn(async () => undefined);
    const view = await mount({ callbacks: callbacks({ applyOps }) });
    expect(view.querySelector('[role^="menuitem"]')).toBeNull();
    await openBoardMenu(view);
    view.querySelector<HTMLButtonElement>('[data-value="resize:sm"]')!.click();
    await vi.waitFor(() => expect(applyOps).toHaveBeenCalledWith([resizeOp(3, 3, "fixed")]));
    const cell = view.querySelector("openclaw-board-widget-cell");
    await vi.waitFor(() =>
      expect(cell?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.disabled).toBe(false),
    );

    await openBoardMenu(view);
    view.querySelector<HTMLButtonElement>('[data-value="height:auto"]')!.click();
    await vi.waitFor(() => expect(applyOps).toHaveBeenLastCalledWith([resizeOp(6, 4, "fixed")]));
  });

  it("returns a pinned widget to automatic height from the menu", async () => {
    const applyOps = vi.fn(async () => undefined);
    const view = await mount({
      snapshot: snapshot({ widgets: [boardWidget({ heightMode: "fixed" })] }),
      callbacks: callbacks({ applyOps }),
    });
    await openBoardMenu(view);
    const auto = view.querySelector<HTMLButtonElement>('[data-value="height:auto"]')!;
    expect(auto.getAttribute("aria-checked")).toBe("false");
    auto.click();
    await vi.waitFor(() => expect(applyOps).toHaveBeenLastCalledWith([resizeOp(6, 4, "auto")]));
  });
});
