import { createComponent } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { BROWSER_ANNOTATION_EVENT } from "./browser-annotation.ts";
import {
  createBrowserClient,
  createBrowserPanelTestController,
  createInspectedNode,
  flushBrowserResponses,
  setupBrowserPanelTestCleanup,
  type BrowserRequestEnvelope,
} from "./browser-panel-controller-test-support.ts";
import type { BrowserPanelController } from "./browser-panel-controller.ts";
import { BrowserPanelChrome } from "./browser-panel-render.tsx";

setupBrowserPanelTestCleanup();

function pointer(type: string, id: number, x: number, y: number, pointerType: string) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperties(event, {
    pointerId: { configurable: true, value: id },
    pointerType: { configurable: true, value: pointerType },
  });
  return event as PointerEvent;
}

function click(x: number, y: number) {
  return new MouseEvent("click", { bubbles: true, clientX: x, clientY: y });
}

function renderInput(controller: BrowserPanelController): HTMLTextAreaElement {
  const root = controller.host.renderRoot;
  const rendered = mountSolid(() =>
    createComponent(BrowserPanelChrome, {
      controller,
      dock: "right",
      height: 400,
      width: 400,
      onDockChange() {},
      onClose() {},
      embedded: false,
      tabsInHeader: false,
    }),
  );
  root.replaceChildren(rendered.container);
  flush();
  vi.spyOn(root.querySelector<HTMLElement>(".bp-stage")!, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 100, 100),
  );
  return root.querySelector<HTMLTextAreaElement>(".bp-input")!;
}

function setup() {
  vi.useFakeTimers();
  const { client, request } = createBrowserClient(async (envelope) => {
    if (envelope.path === "/act") {
      return { result: true };
    }
    throw new Error(`Unexpected browser route: ${envelope.path}`);
  });
  const controller = createBrowserPanelTestController(client, "tab-a");
  const actions = () =>
    request.mock.calls.map(([, envelope]) => (envelope as BrowserRequestEnvelope).body);
  const clicks = () => actions().filter((body) => body?.kind === "clickCoords");
  const scrolls = () =>
    actions()
      .filter((body) => body?.kind === "evaluate")
      .map((body) => /window\.scrollBy\((-?\d+), (-?\d+)\)/.exec(String(body?.fn))?.slice(1));
  return { controller, clicks, scrolls };
}

async function settle() {
  await vi.advanceTimersByTimeAsync(150);
  await flushBrowserResponses();
}

describe("Browser panel touch and pen input", () => {
  it.each(["touch", "pen"])("keeps %s taps as clicks and scrolls drags", async (pointerType) => {
    const { controller, clicks, scrolls } = setup();
    const input = renderInput(controller);

    input.dispatchEvent(pointer("pointerdown", 1, 20, 20, pointerType));
    input.dispatchEvent(pointer("pointerup", 1, 20, 20, pointerType));
    input.dispatchEvent(click(20, 20));
    await settle();
    expect(clicks()).toEqual([{ kind: "clickCoords", targetId: "tab-a", x: 20, y: 20 }]);

    input.dispatchEvent(pointer("pointerdown", 2, 50, 70, pointerType));
    input.dispatchEvent(pointer("pointermove", 2, 50, 40, pointerType));
    input.dispatchEvent(pointer("pointerup", 2, 50, 40, pointerType));
    input.dispatchEvent(click(50, 40));
    await settle();
    input.dispatchEvent(pointer("pointerdown", 3, 50, 40, pointerType));
    input.dispatchEvent(pointer("pointermove", 3, 50, 60, pointerType));
    input.dispatchEvent(pointer("pointercancel", 3, 50, 60, pointerType));
    await settle();

    expect(scrolls()).toEqual([
      ["0", "30"],
      ["0", "-20"],
    ]);
    expect(clicks()).toHaveLength(1);
  });

  it("leaves mouse drags as clicks without remote scrolling", async () => {
    const { controller, clicks, scrolls } = setup();
    const input = renderInput(controller);

    input.dispatchEvent(pointer("pointerdown", 1, 50, 70, "mouse"));
    input.dispatchEvent(pointer("pointermove", 1, 50, 40, "mouse"));
    input.dispatchEvent(pointer("pointerup", 1, 50, 40, "mouse"));
    input.dispatchEvent(click(50, 40));
    await settle();

    expect(scrolls()).toEqual([]);
    expect(clicks()).toEqual([{ kind: "clickCoords", targetId: "tab-a", x: 50, y: 40 }]);
  });

  it("drops a pending pen scroll when capture state resets", async () => {
    const { controller, scrolls } = setup();
    const input = renderInput(controller);

    input.dispatchEvent(pointer("pointerdown", 1, 50, 70, "pen"));
    input.dispatchEvent(pointer("pointermove", 1, 50, 40, "pen"));
    controller.input.resetCaptureState();
    input.dispatchEvent(pointer("pointermove", 1, 50, 10, "pen"));
    await settle();

    expect(scrolls()).toEqual([]);
  });

  it("suppresses the click that follows an inspect pointerdown", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      strokeRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
      "data:image/png;base64,annotated",
    );
    const { controller, clicks } = setup();
    controller.setMode("inspect");
    controller.inspected = createInspectedNode("inspected");
    const acceptAnnotation = vi.fn((event: Event) => event.preventDefault());
    window.addEventListener(BROWSER_ANNOTATION_EVENT, acceptAnnotation);
    try {
      controller.input.handleOverlayPointerDown(pointer("pointerdown", 1, 20, 20, "pen"));
      await flushBrowserResponses();
      expect(controller.mode).toBe("interact");
      controller.handleStageClick(click(20, 20));
      controller.handleStageClick(click(40, 50));
      await flushBrowserResponses();
    } finally {
      window.removeEventListener(BROWSER_ANNOTATION_EVENT, acceptAnnotation);
    }

    expect(acceptAnnotation).toHaveBeenCalledTimes(1);
    expect(clicks()).toEqual([{ kind: "clickCoords", targetId: "tab-a", x: 40, y: 50 }]);
  });
});
