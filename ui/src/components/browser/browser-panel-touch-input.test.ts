import { createComponent } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { setupAnnotationCapture } from "./browser-panel-capture.test-support.ts";
import {
  createBrowserClient,
  createBrowserPanelTestController,
  createInspectedNode,
  flushBrowserResponses,
  setupBrowserPanelTestCleanup,
  type BrowserRequestEnvelope,
} from "./browser-panel-controller-test-support.ts";
import type { BrowserPanel } from "./browser-panel-owner.ts";
import { BrowserPanelChrome } from "./browser-panel-render.tsx";

setupBrowserPanelTestCleanup();
const { receive: acceptAnnotation, stubCanvas } = setupAnnotationCapture();

function pointer(type: string, id: number, x: number, y: number, pointerType: string) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  return Object.assign(event, { pointerId: id, pointerType }) as PointerEvent;
}

const click = (clientX: number, clientY: number) =>
  new MouseEvent("click", { bubbles: true, clientX, clientY });

function renderInput(controller: BrowserPanel): HTMLTextAreaElement {
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

function setup<T>(mount: (controller: BrowserPanel) => T) {
  vi.useFakeTimers();
  const { client, request } = createBrowserClient(async ({ path }) => {
    if (path !== "/act") {
      throw new Error(`Unexpected browser route: ${path}`);
    }
    return { result: true };
  });
  const controller = createBrowserPanelTestController(client, "tab-a");
  const actions = () =>
    request.mock.calls.map(([, envelope]) => (envelope as BrowserRequestEnvelope).body);
  const clicks = () => actions().filter((body) => body?.kind === "clickCoords");
  const scrolls = () =>
    actions()
      .filter((body) => body?.kind === "evaluate")
      .map((body) => /window\.scrollBy\((-?\d+), (-?\d+)\)/.exec(String(body?.fn))?.slice(1));
  return { controller, clicks, scrolls, input: mount(controller) };
}

async function settle() {
  await vi.advanceTimersByTimeAsync(150);
  await flushBrowserResponses();
}

it.each(["touch", "pen", "mouse"])("handles %s taps and drags", async (pointerType) => {
  const { input, clicks, scrolls } = setup(renderInput);
  const tap = { kind: "clickCoords", targetId: "tab-a", x: 20, y: 20 };
  const drag = { kind: "clickCoords", targetId: "tab-a", x: 50, y: 40 };

  input.dispatchEvent(pointer("pointerdown", 1, 20, 20, pointerType));
  input.dispatchEvent(pointer("pointerup", 1, 20, 20, pointerType));
  input.dispatchEvent(click(20, 20));
  await settle();
  expect(clicks()).toEqual([tap]);

  input.dispatchEvent(pointer("pointerdown", 2, 50, 70, pointerType));
  input.dispatchEvent(pointer("pointermove", 2, 50, 40, pointerType));
  input.dispatchEvent(pointer("pointerup", 2, 50, 40, pointerType));
  input.dispatchEvent(click(50, 40));
  await settle();
  input.dispatchEvent(pointer("pointerdown", 3, 50, 40, pointerType));
  input.dispatchEvent(pointer("pointermove", 3, 50, 60, pointerType));
  input.dispatchEvent(pointer("pointercancel", 3, 50, 60, pointerType));
  await settle();

  const deltas = pointerType === "mouse" ? [] : ["30", "-20"];
  expect(scrolls()).toEqual(deltas.map((dy) => ["0", dy]));
  expect(clicks()).toEqual(pointerType === "mouse" ? [tap, drag] : [tap]);
});

it("drops a pending pen scroll when capture state resets", async () => {
  const { controller, input, scrolls } = setup(renderInput);
  input.dispatchEvent(pointer("pointerdown", 1, 50, 70, "pen"));
  input.dispatchEvent(pointer("pointermove", 1, 50, 40, "pen"));
  controller.input.resetCaptureState();
  input.dispatchEvent(pointer("pointermove", 1, 50, 10, "pen"));
  await settle();
  expect(scrolls()).toEqual([]);
});

it("suppresses the click that follows an inspect pointerdown", async () => {
  stubCanvas(["strokeRect"]);
  const { controller, clicks } = setup(() => undefined);
  controller.setMode("inspect");
  controller.inspected = createInspectedNode("inspected");
  acceptAnnotation.mockImplementation((event) => event.preventDefault());
  controller.input.handleOverlayPointerDown(pointer("pointerdown", 1, 20, 20, "pen"));
  expect(controller.mode).toBe("interact");
  controller.input.handleStageClick(click(20, 20));
  controller.input.handleStageClick(click(40, 50));
  await flushBrowserResponses();
  expect(acceptAnnotation).toHaveBeenCalledTimes(1);
  expect(clicks()).toEqual([{ kind: "clickCoords", targetId: "tab-a", x: 40, y: 50 }]);
});
