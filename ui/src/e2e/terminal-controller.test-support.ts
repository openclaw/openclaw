import type {
  CreateGhosttyTerminalOptions,
  GhosttyTerminalController,
} from "@openclaw/libterminal/browser";
import type { Locator, Page } from "playwright";

type TerminalFactory = (
  options: CreateGhosttyTerminalOptions,
) => Promise<GhosttyTerminalController>;

declare global {
  interface Window {
    terminalControllersForTest: WeakMap<HTMLElement, GhosttyTerminalController>;
  }
}

/** Observe the public factory before connection, including after full-page navigation. */
export async function observeTerminalControllers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const controllers = new WeakMap<HTMLElement, GhosttyTerminalController>();
    const observedHosts = new WeakSet<HTMLElement>();
    Object.defineProperty(window, "terminalControllersForTest", { value: controllers });
    const define = customElements.define.bind(customElements);
    customElements.define = function (name, constructor, options) {
      if (name === "openclaw-terminal-panel") {
        const prototype = constructor.prototype as HTMLElement & {
          connectedCallback?: (this: HTMLElement) => void;
        };
        const connected = prototype.connectedCallback;
        prototype.connectedCallback = function () {
          const host = this as HTMLElement & { createTerminalController: TerminalFactory };
          if (!observedHosts.has(host)) {
            observedHosts.add(host);
            const create = host.createTerminalController;
            host.createTerminalController = async function (terminalOptions) {
              const controller = await create.call(this, terminalOptions);
              controllers.set(terminalOptions.parent, controller);
              return controller;
            };
          }
          connected?.call(this);
        };
        customElements.define = define;
      }
      define(name, constructor, options);
    };
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
