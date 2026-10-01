import type { Page } from "playwright";
import { expect, it } from "vitest";
import { startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI terminal runtime isolation",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

type BrowserTerminalController = {
  terminal: {
    getSelection: () => string;
    wasmTerm?: {
      getLine: (row: number) => Array<{ codepoint: number }> | null;
    };
  };
  dispose: () => void;
  write: (bytes: Uint8Array) => void;
};

type BrowserTerminalFactory = (options: {
  autoFit: boolean;
  parent: HTMLElement;
  readOnly: boolean;
  size: { columns: number; rows: number };
}) => Promise<BrowserTerminalController>;

async function loadRuntime(page: Page): Promise<void> {
  const moduleUrl = new URL("src/components/terminal/terminal-runtime.ts", suite.server.baseUrl)
    .href;

  // This suite exercises the real terminal runtime in a private document. The
  // application router and dev-client reloads do not own this document's lifetime.
  const fixtureUrl = new URL("terminal-runtime-fixture", suite.server.baseUrl).href;
  await page.route(fixtureUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body></body></html>",
    }),
  );
  await page.goto(fixtureUrl);
  // addScriptTag resolves before the module body runs, so the global is not
  // observable yet; wait for the assignment instead of racing page.evaluate.
  await page.addScriptTag({
    content: `globalThis.openclawTerminalRuntimeModule = import(${JSON.stringify(moduleUrl)});`,
    type: "module",
  });
  await page.waitForFunction(() =>
    Boolean(
      (globalThis as unknown as { openclawTerminalRuntimeModule?: unknown })
        .openclawTerminalRuntimeModule,
    ),
  );
}

suite.define(() => {
  it("keeps app-handled keys out of terminal input without suppressing terminal controls", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      await loadRuntime(page);
      const result = await page.evaluate(async () => {
        const runtime = await (
          window as unknown as {
            openclawTerminalRuntimeModule: Promise<
              typeof import("../components/terminal/terminal-runtime.ts")
            >;
          }
        ).openclawTerminalRuntimeModule;
        const host = document.body.appendChild(document.createElement("div"));
        const input: string[] = [];
        const controller = await runtime.createIsolatedGhosttyTerminal({
          parent: host,
          autoFit: false,
          readOnly: false,
          size: { columns: 80, rows: 24 },
          onData: (bytes) => input.push(new TextDecoder().decode(bytes)),
        });
        const key = (value: string, ctrlKey = false) =>
          host.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: value,
              code: value === "`" ? "Backquote" : `Key${value.toUpperCase()}`,
              ctrlKey,
              bubbles: true,
              cancelable: true,
            }),
          );
        const handleShortcut = (event: KeyboardEvent) => event.preventDefault();
        document.addEventListener("keydown", handleShortcut, { capture: true, once: true });
        key("`", true);
        const handled = input.splice(0);
        key("a");
        key("c", true);
        key("v", true);
        const controls = input.splice(0);
        // Without an app handler (e.g. a focused terminal document), the same
        // chord still belongs to the terminal rather than toggling a dock.
        key("`", true);
        const unhandled = input.splice(0);
        controller.setReadOnly(true);
        key("b");
        const readOnly = input.splice(0);
        controller.dispose();
        key("d");
        host.remove();
        return { handled, controls, unhandled, readOnly, disposed: input };
      });
      expect(result.handled).toEqual([]);
      expect(result.controls).toEqual(["a", "\u0003"]);
      expect(result.unhandled.join("")).not.toBe("");
      expect(result.readOnly).toEqual([]);
      expect(result.disposed).toEqual([]);
    });
  });

  it("does not reuse freed terminal cells in the next tab", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      await loadRuntime(page);
      const sentinel = "CLOSE_RESET_SENTINEL";
      const result = await page.evaluate(
        async ({ staleText }) => {
          const runtimeModule = await (
            window as unknown as Window & {
              openclawTerminalRuntimeModule: Promise<{
                createIsolatedGhosttyTerminal: BrowserTerminalFactory;
              }>;
            }
          ).openclawTerminalRuntimeModule;
          const createTerminal = async () => {
            const host = document.createElement("div");
            host.style.height = "400px";
            host.style.width = "800px";
            document.body.append(host);
            const controller = await runtimeModule.createIsolatedGhosttyTerminal({
              autoFit: false,
              parent: host,
              readOnly: true,
              size: { columns: 80, rows: 24 },
            });
            return { controller, host };
          };
          const lineText = (controller: BrowserTerminalController) =>
            (controller.terminal.wasmTerm?.getLine(0) ?? [])
              .map((cell) =>
                cell.codepoint > 0 && cell.codepoint <= 0x10ffff
                  ? String.fromCodePoint(cell.codepoint)
                  : " ",
              )
              .join("");

          const first = await createTerminal();
          first.controller.write(new TextEncoder().encode(`${staleText} 👋🏽`));
          const firstLine = lineText(first.controller);
          first.controller.dispose();
          first.host.remove();

          const second = await createTerminal();
          const initialSecondLine = lineText(second.controller);
          second.controller.write(new TextEncoder().encode("FRESH"));
          const finalSecondLine = lineText(second.controller);
          second.controller.dispose();
          second.host.remove();
          return { finalSecondLine, firstLine, initialSecondLine };
        },
        { staleText: sentinel },
      );

      expect(result.firstLine).toContain(sentinel);
      expect(result.initialSecondLine).not.toContain(sentinel);
      expect(result.initialSecondLine.trim()).toBe("");
      expect(result.finalSecondLine).toContain("FRESH");
    });
  });

  it("releases disposed terminal document listeners without breaking live selection", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page, context }) => {
      await loadRuntime(page);
      const cdp = await context.newCDPSession(page);
      // Observe browser-owned roots without wrapping or retaining the callbacks.
      const documentListeners = async () => {
        try {
          const { result } = await cdp.send("Runtime.evaluate", {
            expression: "document",
            objectGroup: "terminal-listeners",
          });
          const { listeners } = await cdp.send("DOMDebugger.getEventListeners", {
            objectId: result.objectId!,
          });
          return listeners.map((listener) => listener.type).toSorted();
        } finally {
          await cdp.send("Runtime.releaseObjectGroup", { objectGroup: "terminal-listeners" });
        }
      };
      const emptyDocumentListeners = await documentListeners();
      let finalDocumentListeners: string[] = [];
      try {
        await page.evaluate(async () => {
          const runtime = await (window as RuntimeWindow).openclawTerminalRuntimeModule;
          const host = document.body.appendChild(document.createElement("div"));
          host.style.cssText = "width:800px;height:400px";
          const controller = await runtime.createIsolatedGhosttyTerminal({
            parent: host,
            autoFit: false,
            readOnly: true,
            size: { columns: 80, rows: 24 },
          });
          controller.write(new TextEncoder().encode("MEMORY_LIFETIME_SENTINEL"));
          (window as RuntimeWindow).liveTerminal = { host, controller };
        });
        const liveDocumentListeners = await documentListeners();
        expect(liveDocumentListeners.length).toBeGreaterThan(emptyDocumentListeners.length);
        await page.evaluate(async () => {
          const runtime = await (window as RuntimeWindow).openclawTerminalRuntimeModule;
          for (let index = 0; index < 3; index++) {
            const host = document.body.appendChild(document.createElement("div"));
            const abort = new AbortController();
            try {
              const controller = await runtime.createIsolatedGhosttyTerminal({
                parent: host,
                autoFit: false,
                readOnly: true,
                signal: abort.signal,
                size: { columns: 80, rows: 24 },
              });
              try {
                controller.write(new TextEncoder().encode("DISPOSED_TERMINAL"));
              } finally {
                if (index === 1) {
                  abort.abort();
                }
                controller.dispose();
                controller.dispose();
              }
            } finally {
              host.remove();
            }
          }
          (window as RuntimeWindow).liveTerminal!.controller.write(
            new TextEncoder().encode(" LIVE_STILL_WRITES"),
          );
        });
        expect(await documentListeners()).toEqual(liveDocumentListeners);
        const line = await page.evaluate(() =>
          ((window as RuntimeWindow).liveTerminal!.controller.terminal.wasmTerm?.getLine(0) ?? [])
            .map((cell) => String.fromCodePoint(cell.codepoint || 32))
            .join(""),
        );
        expect(line).toContain("LIVE_STILL_WRITES");
        const bounds = await page.locator("canvas").boundingBox();
        if (!bounds) {
          throw new Error("Live terminal canvas is not visible");
        }
        await page.mouse.move(bounds.x + 1, bounds.y + 4);
        await page.mouse.down();
        await page.mouse.move(bounds.x + (bounds.width / 80) * 6, bounds.y + 4);
        await page.mouse.up();
        const selection = () =>
          page.evaluate(() =>
            (window as RuntimeWindow).liveTerminal!.controller.terminal.getSelection(),
          );
        expect(await selection()).toContain("MEMORY");
        await page.mouse.click(bounds.x + bounds.width + 10, bounds.y + 4);
        expect(await selection()).toBe("");
      } finally {
        try {
          await page.evaluate(() => {
            const live = (window as RuntimeWindow).liveTerminal;
            live?.controller.dispose();
            live?.host.remove();
            delete (window as RuntimeWindow).liveTerminal;
          });
          finalDocumentListeners = await documentListeners();
        } finally {
          await cdp.detach();
        }
      }
      expect(finalDocumentListeners).toEqual(emptyDocumentListeners);
    });
  });
});
type RuntimeWindow = typeof window & {
  openclawTerminalRuntimeModule: Promise<
    typeof import("../components/terminal/terminal-runtime.ts")
  >;
  liveTerminal?: { host: HTMLElement; controller: BrowserTerminalController };
};
