import { appendFile, mkdir, unlink, writeFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
import type { Page, WebSocket } from "playwright";
import { expect, it } from "vitest";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import { resetLogger, setLoggerOverride } from "../../../src/logging.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI logs lifecycle",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const viewport = { height: 900, width: 1_440 };

function logLine(message: string, level: "error" | "info" | "warn", second: number) {
  return JSON.stringify({
    "0": JSON.stringify({ subsystem: "logs-lifecycle-proof" }),
    "1": message,
    message,
    time: new Date(Date.UTC(2026, 7, 15, 12, 0, second)).toISOString(),
    _meta: { logLevelName: level },
  });
}

async function visibleMessages(page: Page) {
  return page.locator(".log-message").allTextContents();
}

const expectMessages = (page: Page, messages: string[]) =>
  expect.poll(() => visibleMessages(page)).toEqual(messages);

async function downloadLog(page: Page, name: string) {
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name }).click();
  const download = await pending;
  const stream = await download.createReadStream();
  if (!stream) {
    throw new Error("log export did not provide a readable download");
  }
  return { filename: download.suggestedFilename(), contents: await text(stream) };
}

const useLog = (file: string) =>
  setLoggerOverride({ consoleLevel: "silent", file, level: "silent" });

suite.define(() => {
  it("replaces a changed log source and preserves visible recovery through reconnect", async (context) => {
    let fixture: OpenClawTestState | undefined;
    let gateway: Promise<GatewayServer> | undefined;
    let loggerConfigured = false;
    await suite.runScenario(context, {
      retainedState: () => fixture?.root,
      close: async () => {
        const server = await gateway;
        await server?.close({ reason: "logs lifecycle e2e cleanup" });
        if (loggerConfigured) {
          resetLogger();
        }
      },
      release: async () => {
        await fixture?.cleanup();
      },
      run: async (signal) => {
        const port = await getFreePort();
        signal.throwIfAborted();
        const state = await createOpenClawTestState({
          label: "control-ui-logs-lifecycle",
          layout: "home",
          env: {
            OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
            OPENCLAW_SKIP_CANVAS_HOST: "1",
            OPENCLAW_SKIP_CHANNELS: "1",
            OPENCLAW_SKIP_CRON: "1",
            OPENCLAW_SKIP_GMAIL_WATCHER: "1",
            OPENCLAW_SKIP_PROVIDERS: "1",
            OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
            VITEST: "1",
          },
        });
        fixture = state;
        signal.throwIfAborted();
        const sourceA = state.path("source-a.log");
        const sourceB = state.path("source-b.log");
        const readFailure = state.path("read-failure");
        const lineA = logLine("source A only", "info", 1);
        const messageBPrefix = `source B prefix ${"x".repeat(Buffer.byteLength(lineA))}`;
        const lineBPrefix = logLine(messageBPrefix, "info", 2);
        const lineBTail = logLine("source B tail", "error", 3);
        const lineBAppended = logLine("source B appended", "warn", 4);
        const messageBRestartPrefix = `source B restart prefix ${"y".repeat(
          Buffer.byteLength(`${lineBPrefix}\n${lineBTail}\n${lineBAppended}\n`),
        )}`;
        const lineBRestartPrefix = logLine(messageBRestartPrefix, "info", 5);
        const lineBRestartTail = logLine("source B restart tail", "error", 6);
        const lineBAfterReconnect = logLine("source B after reconnect", "warn", 7);
        const writeLog = async (file: string, ...lines: string[]) => {
          await writeFile(file, `${lines.join("\n")}\n`, "utf8");
          signal.throwIfAborted();
        };
        const { startGatewayServer } = await import("../../../src/gateway/server.js");
        signal.throwIfAborted();
        await writeLog(sourceA, lineA);
        await writeLog(sourceB, lineBPrefix, lineBTail);
        await mkdir(readFailure);
        signal.throwIfAborted();
        await state.writeConfig({
          gateway: {
            auth: { mode: "none" },
            controlUi: {
              allowedOrigins: [new URL(suite.server.baseUrl).origin],
              enabled: false,
            },
            port,
          },
        });
        signal.throwIfAborted();
        loggerConfigured = true;
        useLog(sourceA);
        const start = () =>
          startGatewayServer(port, {
            auth: { mode: "none" },
            bind: "loopback",
            controlUiEnabled: false,
            sidecarStartup: "defer",
          });
        gateway = start();
        const server = await gateway;
        signal.throwIfAborted();

        await suite.withPage(
          {
            locale: "en-US",
            serviceWorkers: "block",
            viewport,
          },
          async ({ page }) => {
            const pageErrors: string[] = [];
            let latestSocket: WebSocket | undefined;
            page.on("websocket", (socket) => (latestSocket = socket));
            page.on("pageerror", (error) => pageErrors.push(String(error)));
            const url = new URL("logs", suite.server.baseUrl);
            url.searchParams.set("gatewayUrl", `ws://127.0.0.1:${port}`);
            await page.goto(url.toString());
            const confirmation = page.locator("openclaw-gateway-url-confirmation");
            await confirmation.waitFor();
            await confirmation
              .getByRole("button", { name: `Switch to 127.0.0.1:${port}`, exact: true })
              .click();
            await waitForControlUiGatewayReady(page);
            await expectMessages(page, ["source A only"]);

            useLog(sourceB);
            await expect
              .poll(() => page.locator(".logs-card .settings-row").first().textContent())
              .toContain(sourceB);
            await expectMessages(page, [messageBPrefix, "source B tail"]);

            const filter = page.getByRole("textbox", { name: "Filter" });
            await filter.fill("source B tail");
            await expectMessages(page, ["source B tail"]);
            const download = await downloadLog(page, "Export filtered");
            expect(download.filename).toMatch(/^openclaw-logs-filtered-.*\.log$/);
            expect(download.contents).toBe(`${lineBTail}\n`);

            await filter.fill("");
            await page.locator("label.log-chip.info input").uncheck();
            await expectMessages(page, ["source B tail"]);
            await page.locator("label.log-chip.info input").check();
            await appendFile(sourceB, `${lineBAppended}\n`, "utf8");
            const appended = [messageBPrefix, "source B tail", "source B appended"];
            await expectMessages(page, appended);

            useLog(readFailure);
            const error = page.locator(".logs-refresh-status[role=alert]");
            await expect.poll(() => error.isVisible()).toBe(true);
            await expect.poll(() => error.textContent()).toContain("log read failed");
            await expect.poll(() => error.textContent()).toContain("Showing stale data");
            await expectMessages(page, appended);

            useLog(sourceB);
            await expect.poll(() => error.count()).toBe(0);
            await expect.poll(() => visibleMessages(page)).toHaveLength(3);

            await server.close({ reason: "logs lifecycle reconnect proof" });
            gateway = undefined;
            signal.throwIfAborted();
            await page.waitForFunction(() => {
              return window.openclawControlUi?.snapshot().gatewayPhase === "reconnecting";
            });
            await expect
              .poll(() =>
                page.locator(".sidebar-shell__footer .gateway-status__label").textContent(),
              )
              .toContain("Reconnecting…");
            await expect.poll(() => visibleMessages(page)).toHaveLength(3);
            signal.throwIfAborted();
            await writeLog(sourceB, lineBRestartPrefix, lineBRestartTail);
            gateway = start();
            await gateway;
            signal.throwIfAborted();
            await waitForControlUiGatewayReady(page);
            await expectMessages(page, [messageBRestartPrefix, "source B restart tail"]);
            // The preview build differs from this cross-origin source Gateway; reloading
            // the preview cannot change that, so the status must settle as connected.
            await page
              .locator(".sidebar-shell__footer .gateway-status")
              .waitFor({ state: "detached" });
            await appendFile(sourceB, `${lineBAfterReconnect}\n`, "utf8");
            await expectMessages(page, [
              messageBRestartPrefix,
              "source B restart tail",
              "source B after reconnect",
            ]);

            if (!latestSocket) {
              throw new Error("Logs did not open a Gateway connection");
            }
            const missingTail = latestSocket.waitForEvent("framereceived", {
              timeout: 15_000,
              predicate: ({ payload }) => {
                const frame: {
                  type: string;
                  ok?: boolean;
                  payload?: { file: string; cursor: number };
                } = JSON.parse(payload.toString());
                return (
                  frame.type === "res" &&
                  frame.ok === true &&
                  frame.payload?.file === sourceB &&
                  frame.payload.cursor === 0
                );
              },
            });
            await unlink(sourceB);
            await missingTail;
            const replacement = logLine("source B replacement", "info", 8);
            await writeLog(sourceB, replacement);
            await page.getByText("source B replacement", { exact: true }).waitFor();
            expect.soft(await visibleMessages(page)).toEqual(["source B replacement"]);
            const { contents: replacementExport } = await downloadLog(page, "Export visible");
            expect.soft(replacementExport).toBe(`${replacement}\n`);
            expect(pageErrors).toEqual([]);
          },
        );
      },
    });
  });
});
