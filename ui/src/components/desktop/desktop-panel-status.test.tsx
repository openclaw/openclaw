import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { DesktopViewerHint } from "./desktop-panel-status.tsx";

it("retires the fullscreen viewer pointer position when presentation changes", () => {
  const [active, setActive] = createSignal(true);
  const [fullscreen, setFullscreen] = createSignal(true);
  let stage!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  const view = mountSolid(() => (
    <div ref={(element) => (stage = element)}>
      <div class="desktop-surface">
        <canvas ref={(element) => (canvas = element)} />
      </div>
      <DesktopViewerHint stage={() => stage} active={active()} fullscreen={fullscreen()} />
    </div>
  ));
  vi.spyOn(stage, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 100));
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 100));
  flush();
  const hint = stage.querySelector<HTMLElement>(".desktop-viewer-hint")!;
  const move = (clientX = 50) => {
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX, clientY: 50, bubbles: true }));
    flush();
  };

  move();
  expect(hint.dataset.positioned).toBe("true");
  setActive(false);
  flush();
  expect(hint.dataset.positioned).toBe("false");
  move();
  expect(hint.dataset.positioned).toBe("false");
  setActive(true);
  flush();
  expect(hint.dataset.positioned).toBe("false");
  move();
  expect(hint.dataset.positioned).toBe("true");
  setFullscreen(false);
  flush();
  expect(hint.dataset.positioned).toBe("false");
  setFullscreen(true);
  flush();
  move(150);
  expect(hint.dataset.positioned).toBe("false");
  move();
  stage.dispatchEvent(new Event("pointerleave"));
  flush();
  expect(hint.dataset.positioned).toBe("false");

  view.unmount();
  move();
  expect(hint.dataset.positioned).toBe("false");
});
