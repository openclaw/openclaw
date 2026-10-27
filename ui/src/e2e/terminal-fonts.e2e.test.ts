import type { Page } from "playwright";
import { expect, it } from "vitest";
import { waitForControlUiTerminalReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { installMockGateway, startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";
import {
  observeTerminalControllers,
  readTerminalCanvasState,
} from "./terminal-controller.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "terminal fonts",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
});

const terminalSession = { agentId: "main", confined: false, cwd: "/workspace", shell: "/bin/zsh" };
function installTerminal(page: Page, sessionId: string, reattach = false) {
  return installMockGateway(page, {
    terminalEnabled: true,
    featureMethods: ["terminal.open"],
    methodResponses: {
      "terminal.list": {
        sessions: reattach
          ? [{ ...terminalSession, sessionId, attached: true, createdAtMs: 1 }]
          : [],
      },
      "terminal.open": { ...terminalSession, sessionId },
    },
  });
}
function hasNerdFontStatus(status: "loaded" | "error") {
  return [...document.fonts].some(
    (font) => font.family.includes("OpenClaw Nerd Symbols") && font.status === status,
  );
}
const expectFontStatus = (page: Page, status: "loaded" | "error") =>
  expect.poll(() => page.evaluate(hasNerdFontStatus, status)).toBe(true);

suite.define(() => {
  it("renders bundled Nerd Font glyphs in a real terminal", () =>
    suite.withPage(
      { serviceWorkers: "block", viewport: { width: 1180, height: 600 }, deviceScaleFactor: 2 },
      async ({ page, context }) => {
        await observeTerminalControllers(page);
        const fontDownload = await holdModuleResponse(page, /symbols-nerd-font-mono\.woff2/);
        const gateway = await installTerminal(page, "font-proof");
        await page.goto(suite.server.baseUrl + "activity");
        await waitForControlUiTerminalReady(page);
        await page.keyboard.press("Control+Backquote");
        await gateway.waitForRequest("terminal.open");
        const canvas = page.locator(".tp-host canvas");
        await canvas.waitFor();
        const glyphs =
          "\uf007 \uf07b \ue0a0 \uf013 \uf120 \uf17c \uf121 \udb80\udf44 \ue0b0 \ue0b2";
        const output = `\x1b[?25lOpenClaw ${glyphs}\r\n\x1b[1m${glyphs}\x1b[0m café naïve λ → 日本語\r\n`;
        await gateway.emitGatewayEvent("terminal.data", {
          sessionId: "font-proof",
          seq: output.length,
          data: output,
        });
        await expect
          .poll(async () => (await readTerminalCanvasState(canvas)).width)
          .toBeGreaterThan(0);
        await fontDownload.request;
        const fallbackPixels = await canvas.evaluate((element) =>
          (element as HTMLCanvasElement).toDataURL(),
        );
        fontDownload.release();
        await expectFontStatus(page, "loaded");
        await expect
          .poll(() => canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL()))
          .not.toBe(fallbackPixels);
        const terminalState = () => readTerminalCanvasState(canvas);
        const initial = await terminalState();
        expect(initial.width).toBe(initial.cssWidth * initial.dpr);
        expect(initial.family).toContain('"JetBrains Mono"');
        expect(initial.text).toContain("OpenClaw");
        const settings = await context.newPage();
        await installMockGateway(settings);
        await settings.goto(suite.server.baseUrl + "settings/appearance");
        const input = settings.getByRole("textbox", { name: "Terminal font", exact: true });
        await input.fill("DejaVu Sans Mono");
        await input.press("Tab");
        await expect
          .poll(async () => (await terminalState()).family)
          .toMatch(/^"DejaVu Sans Mono",/);
        const changed = await terminalState();
        expect(changed.text).toBe(initial.text);
        expect(changed.width).toBe(changed.cssWidth * changed.dpr);
        expect(await gateway.getRequests("terminal.open")).toHaveLength(1);
        await input.fill('"bad", serif');
        await input.press("Tab");
        expect(
          await input.evaluate((element) => (element as HTMLInputElement).validity.valid),
        ).toBe(false);
        expect((await terminalState()).family).toBe(changed.family);
        await input.fill("Font That Is Not Installed");
        await input.press("Tab");
        await expect
          .poll(async () => (await terminalState()).family)
          .toContain("Font That Is Not Installed");
        expect((await terminalState()).text).toBe(initial.text);
        await settings.getByRole("button", { name: "Use default", exact: true }).click();
        await expect.poll(async () => (await terminalState()).family).toBe(initial.family);
        await settings.close();
      },
    ));
  it("keeps the main terminal usable when the bundled font download fails", () =>
    suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/symbols-nerd-font-mono.woff2*", (route) => route.abort());
      const gateway = await installTerminal(page, "failed-font", true);
      await page.goto(suite.server.baseUrl + "terminal");
      await gateway.waitForRequest("terminal.open");
      await page.locator(".tp-session.is-current").click();
      const canvas = page.locator(".tp-host canvas");
      await canvas.waitFor();
      await expectFontStatus(page, "error");
      await canvas.click();
      await page.keyboard.type("echo still-usable");
      await expect
        .poll(async () => (await gateway.getRequests("terminal.input")).length)
        .toBeGreaterThan(0);
      expect(await gateway.getRequests("terminal.open")).toHaveLength(1);
      expect(errors).toEqual([]);
    }));
});
