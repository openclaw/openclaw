import { createComponent } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { emulateOverlayMedia } from "../../test-helpers/overlay-browser-media.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { setupBrowserPanelTestCleanup } from "./browser-panel-controller-test-support.ts";
import { BrowserPanelChrome } from "./browser-panel-render.tsx";
import { panelScenario } from "./browser-panel-stream.test-support.ts";
import styles from "./browser-panel.css?inline";

setupBrowserPanelTestCleanup();
afterEach(() => emulateOverlayMedia({ reducedMotion: "no-preference" }));

it("keeps the reduced-motion press cue on the press and inside the stage", async () => {
  await emulateOverlayMedia({ reducedMotion: "reduce" });
  const { controller } = panelScenario("tab-a", undefined, {});
  const host = document.body.appendChild(document.createElement("openclaw-browser-panel"));
  host.innerHTML = `<style>${styles}</style>`;
  mountSolid(
    () =>
      createComponent(BrowserPanelChrome, {
        controller,
        dock: "right",
        height: 300,
        width: 300,
        onDockChange() {},
        onClose() {},
        embedded: false,
        tabsInHeader: false,
      }),
    { container: host },
  );
  flush();
  const find = (selector: string) => host.querySelector<HTMLElement>(selector)!;
  // The stage takes its height from the screenshot; a fixed size gives it real layout.
  find(".bp-shot").style.height = "300px";
  const { left, top, right, bottom } = find(".bp-stage").getBoundingClientRect();
  const press = (clientX: number, clientY: number) =>
    find(".bp-input").dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", clientX, clientY }),
    );

  press(left + 100, top + 40);
  const cue = find(".bp-press").getAnimations()[0]!;
  cue.pause();
  cue.currentTime = 150;
  const box = find(".bp-press").getBoundingClientRect();
  expect([box.left + box.width / 2, box.top + box.height / 2].map(Math.round)).toEqual([
    left + 100,
    top + 40,
  ]);

  // A finished cue at the far corner must not leave scrollable overflow behind.
  press(right - 1, bottom - 1);
  find(".bp-press").getAnimations()[0]!.finish();
  const viewport = find(".bp-viewport");
  expect([viewport.scrollWidth, viewport.scrollHeight]).toEqual([
    viewport.clientWidth,
    viewport.clientHeight,
  ]);
  controller.input.resetCaptureState();
  expect(find(".bp-press").getAnimations()).toEqual([]);
});
