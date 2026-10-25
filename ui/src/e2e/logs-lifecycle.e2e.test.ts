import { writeFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import { resetLogger, setLoggerOverride } from "../../../src/logging.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI logs lifecycle",
  startServerBeforeBrowser: true,
});

const viewport = { height: 900, width: 1_440 };

const logLine = (message: string, level: "error" | "info") =>
  JSON.stringify({ message, _meta: { logLevelName: level } });

const visibleMessages = (page: Page) => page.locator(".log-message").allTextContents();

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
  it("exports filtered and visible rows from the selected log source", async (context) => {
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
        const lineA = logLine("source A only", "info");
        const messageBPrefix = `source B prefix ${"x".repeat(Buffer.byteLength(lineA))}`;
        const lineBPrefix = logLine(messageBPrefix, "info");
        const lineBTail = logLine("source B tail", "error");
        const writeLog = async (file: string, ...lines: string[]) => {
          await writeFile(file, `${lines.join("\n")}\n`, "utf8");
          signal.throwIfAborted();
        };
        const { startGatewayServer } = await import("../../../src/gateway/server.js");
        signal.throwIfAborted();
        await writeLog(sourceA, lineA);
        await writeLog(sourceB, lineBPrefix, lineBTail);
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
        gateway = startGatewayServer(port, {
          auth: { mode: "none" },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        });
        await gateway;
        signal.throwIfAborted();

        await suite.withPage(
          {
            locale: "en-US",
            serviceWorkers: "block",
            viewport,
          },
          async ({ page }) => {
            const pageErrors: string[] = [];
            page.on("pageerror", (error) => pageErrors.push(String(error)));
            const nextPoll = async () => {
              await pauseVirtualClock(page);
              await page.clock.runFor(2_001);
              await page.clock.resume();
            };
            const url = new URL("logs", suite.server.baseUrl);
            url.searchParams.set("gatewayUrl", `ws://127.0.0.1:${port}`);
            await page.clock.install();
            await page.goto(url.toString());
            const confirmation = page.locator("openclaw-gateway-url-confirmation");
            await confirmation.waitFor();
            await confirmation
              .getByRole("button", { name: `Switch to 127.0.0.1:${port}`, exact: true })
              .click();
            await waitForControlUiGatewayReady(page);
            await expectMessages(page, ["source A only"]);

            useLog(sourceB);
            await nextPoll();
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
            const { contents } = await downloadLog(page, "Export visible");
            expect(contents).toBe(lineBPrefix + "\n" + lineBTail + "\n");
            expect(pageErrors).toEqual([]);
          },
        );
      },
    });
  });
});
