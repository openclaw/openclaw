import { createSignal, flush } from "@solidjs/signals";
import { render } from "@solidjs/web";
import { createComponent } from "solid-js";
import { afterEach } from "vitest";
import type { BrowserPanelController } from "./browser-panel-controller.ts";
import { BrowserPanelChrome } from "./browser-panel-render.tsx";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
});

export function mountBrowserPanelChrome(
  controller: BrowserPanelController,
  root: HTMLElement | DocumentFragment,
) {
  const [revision, setRevision] = createSignal(0);
  const dispose = render(
    () =>
      createComponent(BrowserPanelChrome, {
        get controller() {
          revision();
          return controller;
        },
        dock: "right",
        height: 400,
        width: 400,
        onDockChange() {},
        onClose() {},
        embedded: false,
        tabsInHeader: false,
      }),
    root,
  );
  disposers.push(dispose);
  flush();
  return () => {
    setRevision((value) => value + 1);
    flush();
  };
}
