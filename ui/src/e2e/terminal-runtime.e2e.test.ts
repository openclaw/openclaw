import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  pauseVirtualClock,
  startControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  observeTerminalControllers,
  readTerminalCanvasState,
} from "./terminal-controller.test-support.ts";

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
  it("confirms successful terminal selection copies without claiming failed or pending copies", async () => {
    await suite.withPage(
      {
        serviceWorkers: "block",
        viewport: { width: 1280, height: 900 },
        permissions: ["clipboard-read", "clipboard-write"],
      },
      async ({ page }) => {
        await observeTerminalControllers(page);
        const gateway = await installMockGateway(page, {
          terminalEnabled: true,
          featureMethods: [...defaultControlUiFeatureMethods, "terminal.open"],
          methodResponses: {
            "terminal.list": { sessions: [] },
            "terminal.input": { ok: true },
            "terminal.resize": { ok: true },
            "terminal.attach": {
              agentId: "main",
              confined: false,
              cwd: "/workspace",
              sessionId: "copy-terminal",
              shell: "/bin/bash",
              buffer: "$ echo hello\r\nhello\r\n$ ",
              seq: 23,
            },
            "terminal.open": {
              agentId: "main",
              confined: false,
              cwd: "/workspace",
              sessionId: "copy-terminal",
              shell: "/bin/bash",
            },
          },
        });
        await page.goto(suite.server.baseUrl + "chat");
        await waitForControlUiGatewayReady(page);
        await page.locator(".agent-chat__composer-combobox textarea").waitFor();
        await page.keyboard.press("Control+Backquote");
        const panel = page
          .locator("openclaw-terminal-panel")
          .filter({ has: page.locator(".tp-host") });
        const canvas = panel.locator("canvas");
        await canvas.waitFor();
        await gateway.waitForRequest("terminal.open");
        const output = "$ echo hello\r\nhello\r\n$ ";
        await gateway.emitGatewayEvent("terminal.data", {
          sessionId: "copy-terminal",
          seq: output.length,
          data: output,
        });
        await page.clock.install();
        await pauseVirtualClock(page);
        const drag = async () => {
          const bounds = await canvas.boundingBox();
          if (!bounds) {
            throw new Error("Terminal canvas is not visible");
          }
          // The real terminal renderer owns cell metrics; use its public dimensions.
          const metrics = await readTerminalCanvasState(canvas);
          await page.mouse.move(bounds.x + 1, bounds.y + metrics.cellHeight * 1.5);
          await page.mouse.down();
          await page.mouse.move(
            bounds.x + metrics.cellWidth * 4.5,
            bounds.y + metrics.cellHeight * 1.5,
            {
              steps: 5,
            },
          );
          await page.mouse.up();
        };
        await drag();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("hello");
        await page.clock.runFor(32);
        const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR
          ? createControlUiE2eArtifactDir("terminal-copy")
          : undefined;
        const capture = async (name: string) => {
          if (!artifactDir) {
            return;
          }
          const frame = await takeControlUiScreenshotFrame(
            page,
            panel.locator(".tp"),
            [canvas, toast],
            {
              animations: "disabled",
            },
          );
          await writeFile(path.join(artifactDir, name + ".png"), frame.png);
        };
        const toast = page.locator('.app-toast[role="status"]');
        expect(await toast.textContent()).toContain("Copied to clipboard");
        expect(await toast.getAttribute("aria-live")).toBe("polite");
        await capture("right-copy");
        expect(await panel.evaluate((element) => element.contains(document.activeElement))).toBe(
          true,
        );
        await page.keyboard.type("pwd");
        expect(await gateway.getRequests("terminal.input")).toEqual(
          expect.arrayContaining(
            ["p", "w", "d"].map((data) =>
              expect.objectContaining({
                params: { sessionId: "copy-terminal", data },
              }),
            ),
          ),
        );
        await page.clock.runFor(1_000);
        await drag();
        await page.clock.runFor(1_100);
        expect(await toast.getAttribute("data-active")).toBe("true");
        expect(await toast.count()).toBe(1);
        await page.clock.runFor(1_500);
        expect(await toast.count()).toBe(0);

        await page.getByRole("button", { name: "Dock to bottom", exact: true }).click();
        await panel.locator(".tp-host canvas:visible").waitFor();
        await page.clock.runFor(32);
        await drag();
        expect(await toast.textContent()).toContain("Copied to clipboard");
        await capture("bottom-copy");
        await page.clock.runFor(2_500);

        // Retain the real API for the first copy above; control only the transport
        // outcomes below, not the terminal's selection/copy/notification handlers.
        await page.evaluate(() => {
          const state = {
            fallback: false,
            fallbackCalls: 0,
            writes: 0,
            settle: undefined as (() => void) | undefined,
          };
          Object.assign(window, { terminalClipboard: state });
          Object.defineProperty(navigator.clipboard, "writeText", {
            configurable: true,
            value: () => {
              state.writes++;
              return Promise.reject(new DOMException("Clipboard denied", "NotAllowedError"));
            },
          });
          document.execCommand = () => {
            state.fallbackCalls++;
            return state.fallback;
          };
        });
        await drag();
        expect(
          await page.evaluate(() => (window as ClipboardWindow).terminalClipboard.fallbackCalls),
        ).toBe(1);
        expect(await toast.count()).toBe(0);
        await page.evaluate(() => {
          (window as ClipboardWindow).terminalClipboard.fallback = true;
        });
        await drag();
        expect(
          await page.evaluate(() => (window as ClipboardWindow).terminalClipboard.fallbackCalls),
        ).toBe(2);
        expect(await toast.textContent()).toContain("Copied to clipboard");
        await page.clock.runFor(2_500);
        expect(await toast.count()).toBe(0);

        await page.evaluate(() => {
          const state = (window as ClipboardWindow).terminalClipboard;
          Object.defineProperty(navigator.clipboard, "writeText", {
            configurable: true,
            value: () => {
              state.writes++;
              return new Promise<void>((resolve) => {
                state.settle = resolve;
              });
            },
          });
        });
        await drag();
        expect(
          await page.evaluate(() => (window as ClipboardWindow).terminalClipboard.writes),
        ).toBe(3);
        expect(await toast.count()).toBe(0);
        await page.evaluate(() => (window as ClipboardWindow).terminalClipboard.settle!());
        expect(await toast.textContent()).toContain("Copied to clipboard");
        await page.clock.runFor(2_500);
        await drag();
        // A clipboard write settling after its terminal is hidden must not notify
        // whichever conversation/tool has replaced that terminal.
        await panel.getByRole("button", { name: "Hide terminal", exact: true }).click();
        await canvas.waitFor({ state: "hidden" });
        await page.evaluate(() => (window as ClipboardWindow).terminalClipboard.settle!());
        expect(await toast.count()).toBe(0);

        // The chrome-free terminal has its own toast host, including narrow screens.
        await page.clock.resume();
        await page.setViewportSize({ width: 420, height: 800 });
        await page.emulateMedia({ colorScheme: "dark" });
        // A fresh mock document has no server-side PTY roster to restore.
        await page.evaluate(() => sessionStorage.removeItem("openclaw.terminal.sessions.v1"));
        await page.goto(suite.server.baseUrl + "focus/terminal");
        await canvas.waitFor();
        await page.evaluate(() => navigator.clipboard.writeText("before focus selection"));
        await gateway.emitGatewayEvent("terminal.data", {
          sessionId: "copy-terminal",
          seq: output.length,
          data: output,
        });
        await panel.locator(".tabstrip-tab.is-live").waitFor();
        await pauseVirtualClock(page);
        await drag();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("hello");
        expect(await toast.textContent()).toContain("Copied to clipboard");
        await capture("focused-narrow-copy");
      },
    );
  });
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
type ClipboardWindow = typeof window & {
  terminalClipboard: {
    fallback: boolean;
    fallbackCalls: number;
    writes: number;
    settle?: () => void;
  };
};

type RuntimeWindow = typeof window & {
  openclawTerminalRuntimeModule: Promise<
    typeof import("../components/terminal/terminal-runtime.ts")
  >;
  liveTerminal?: { host: HTMLElement; controller: BrowserTerminalController };
};
