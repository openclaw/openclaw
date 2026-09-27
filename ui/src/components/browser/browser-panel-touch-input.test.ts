import { nothing, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import {
  createBrowserClient,
  createBrowserPanelTestController,
  createView,
  flushBrowserResponses,
  setupBrowserPanelTestCleanup,
  type BrowserRequestEnvelope,
} from "./browser-panel-controller-test-support.ts";
import { renderBrowserPanelChrome } from "./browser-panel-render.ts";

setupBrowserPanelTestCleanup();

function pointer(type: string, id: number, x: number, y: number, pointerType = "touch") {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: x,
    clientY: y,
  });
  Object.defineProperties(event, {
    pointerId: { configurable: true, value: id },
    pointerType: { configurable: true, value: pointerType },
  });
  return event as PointerEvent;
}

describe("Browser panel touch and pen input", () => {
  it.each(["touch", "pen"] as const)(
    "keeps %s taps and scrolls upward drags",
    async (pointerType) => {
      vi.useFakeTimers();
      const { client, request } = createBrowserClient(async (envelope) => {
        if (envelope.path === "/act") {
          return { result: true };
        }
        throw new Error(`Unexpected browser route: ${envelope.path}`);
      });
      const controller = createBrowserPanelTestController(client, "tab-a");
      const root = controller.host.renderRoot;
      render(
        renderBrowserPanelChrome(
          controller,
          "right",
          400,
          400,
          () => {},
          () => {},
          nothing,
        ),
        root,
      );
      vi.spyOn(
        root.querySelector<HTMLElement>(".bp-stage")!,
        "getBoundingClientRect",
      ).mockReturnValue({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 100,
        bottom: 100,
        width: 100,
        height: 100,
        toJSON: () => ({}),
      });
      const input = root.querySelector<HTMLTextAreaElement>(".bp-input")!;
      input.dispatchEvent(pointer("pointerdown", 1, 20, 20, pointerType));
      input.dispatchEvent(pointer("pointerup", 1, 20, 20, pointerType));
      input.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 20, clientY: 20 }));
      await flushBrowserResponses();
      input.dispatchEvent(pointer("pointerdown", 2, 50, 70, pointerType));
      input.dispatchEvent(pointer("pointermove", 2, 50, 40, pointerType));
      input.dispatchEvent(pointer("pointerup", 2, 50, 40, pointerType));
      input.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 50, clientY: 40 }));
      await vi.advanceTimersByTimeAsync(150);
      await flushBrowserResponses();

      const actions = request.mock.calls.map(
        ([, envelope]) => (envelope as BrowserRequestEnvelope).body,
      );
      expect(actions.filter((body) => body?.kind === "clickCoords")).toHaveLength(1);
      expect(
        actions.filter(
          (body) => typeof body?.fn === "string" && body.fn.includes("window.scrollBy(0, 30)"),
        ),
      ).toHaveLength(1);
      const viewport = root.querySelector<HTMLElement>(".bp-viewport")!;
      viewport.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, deltaX: 2, deltaY: 10, cancelable: true }),
      );
      viewport.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, deltaX: 3, deltaY: 20, cancelable: true }),
      );
      await vi.advanceTimersByTimeAsync(150);
      await flushBrowserResponses();
      const scrolls = request.mock.calls
        .map(([, envelope]) => (envelope as BrowserRequestEnvelope).body)
        .filter((body) => body?.kind === "evaluate");
      expect(scrolls).toHaveLength(2);
      expect(scrolls[1]).toMatchObject({
        kind: "evaluate",
        fn: expect.stringContaining("window.scrollBy(5, 30)"),
      });
    },
  );

  it("does not route native-tab touch gestures through remote scrolling", async () => {
    vi.useFakeTimers();
    const { client, request } = createBrowserClient(async () => ({ result: true }));
    const controller = createBrowserPanelTestController(client, "tab-a");
    controller.view = { ...createView("tab-a"), kind: "native" };
    const input = document.createElement("textarea");
    controller.host.renderRoot.append(input);
    input.addEventListener("pointerdown", (event) =>
      controller.input.handleOverlayPointerDown(event as PointerEvent),
    );
    input.addEventListener("pointermove", (event) =>
      controller.handleOverlayPointerMove(event as PointerEvent),
    );
    input.addEventListener("pointerup", (event) =>
      controller.input.handleOverlayPointerUp(event as PointerEvent),
    );
    input.dispatchEvent(pointer("pointerdown", 4, 50, 70));
    input.dispatchEvent(pointer("pointermove", 4, 50, 40));
    input.dispatchEvent(pointer("pointerup", 4, 50, 40));
    await vi.advanceTimersByTimeAsync(150);
    expect(request.mock.calls).toEqual([]);
  });

  it("releases and drops pending scroll on lifecycle reset", async () => {
    vi.useFakeTimers();
    const { client, request } = createBrowserClient(async () => ({ result: true }));
    const controller = createBrowserPanelTestController(client, "tab-a");
    const input = document.createElement("textarea");
    const captured = new Set<number>();
    input.setPointerCapture = vi.fn((id) => captured.add(id));
    input.hasPointerCapture = vi.fn((id) => captured.has(id));
    const releasePointerCapture = vi.fn((id) => captured.delete(id));
    input.releasePointerCapture = releasePointerCapture;
    controller.host.renderRoot.append(input);
    input.addEventListener("pointerdown", (event) =>
      controller.input.handleOverlayPointerDown(event as PointerEvent),
    );
    input.addEventListener("pointermove", (event) =>
      controller.handleOverlayPointerMove(event as PointerEvent),
    );
    input.dispatchEvent(pointer("pointerdown", 3, 50, 70));
    input.dispatchEvent(pointer("pointermove", 3, 50, 40));
    controller.input.resetCaptureState();
    await vi.advanceTimersByTimeAsync(150);
    await flushBrowserResponses();
    expect(releasePointerCapture).toHaveBeenCalledWith(3);
    expect(captured.has(3)).toBe(false);
    expect(
      request.mock.calls.filter(
        ([, envelope]) => (envelope as BrowserRequestEnvelope).path === "/act",
      ),
    ).toEqual([]);
  });
});
