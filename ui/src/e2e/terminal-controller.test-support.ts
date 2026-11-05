import type { GhosttyTerminalController } from "@openclaw/libterminal/browser";
import type { Locator, Page } from "playwright";

declare global {
  interface Window {
    terminalControllersForTest: WeakMap<HTMLElement, GhosttyTerminalController>;
  }
}

/** Observe the real source runtime at its module boundary, including after navigation. */
export async function observeTerminalControllers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, "terminalControllersForTest", {
      value: new WeakMap<HTMLElement, GhosttyTerminalController>(),
    });
  });
  await page.route(/\/src\/components\/terminal\/terminal-runtime\.ts(?:\?|$)/, (route) => {
    const original = new URL(route.request().url());
    if (original.searchParams.has("terminal-observer-original")) {
      return route.continue();
    }
    original.searchParams.set("terminal-observer-original", "1");
    const source = JSON.stringify(original.href);
    return route.fulfill({
      contentType: "text/javascript",
      body: `
        export * from ${source};
        import { createIsolatedGhosttyTerminal as create } from ${source};
        export async function createIsolatedGhosttyTerminal(...args) {
          const controller = await create(...args);
          window.terminalControllersForTest.set(args[0].parent, controller);
          return controller;
        }
      `,
    });
  });
}

/** Read the real renderer associated with this canvas's independent DOM island. */
export function readTerminalCanvasState(canvas: Locator) {
  return canvas.evaluate((element) => {
    const host = element.closest(".tp-host");
    if (!(element instanceof HTMLCanvasElement) || !(host instanceof HTMLElement)) {
      throw new Error("Expected a terminal canvas inside its .tp-host island");
    }
    const controller = window.terminalControllersForTest.get(host);
    const terminal = controller?.terminal;
    const renderer = terminal?.renderer;
    const wasmTerm = terminal?.wasmTerm;
    if (!terminal || !renderer || !wasmTerm) {
      throw new Error("The observed terminal renderer is not ready");
    }
    return {
      cellWidth: renderer.charWidth,
      cellHeight: renderer.charHeight,
      family: terminal.options.fontFamily,
      width: element.width,
      cssWidth: Number.parseFloat(element.style.width),
      dpr: devicePixelRatio,
      text: (wasmTerm.getLine(0) ?? [])
        .map((cell) => String.fromCodePoint(cell.codepoint || 32))
        .join(""),
    };
  });
}
