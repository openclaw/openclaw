import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  waitForControlUiGatewayReady,
  waitForControlUiTerminalReady,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
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

suite.define(() => {
  it("renders bundled Nerd Font glyphs in a real terminal", async () => {
    await suite.withPage(
      { serviceWorkers: "block", viewport: { width: 1180, height: 600 }, deviceScaleFactor: 2 },
      async ({ page, context }) => {
        await observeTerminalControllers(page);
        const fontDownload = await holdModuleResponse(page, /symbols-nerd-font-mono\.woff2/);
        const gateway = await installMockGateway(page, {
          terminalEnabled: true,
          featureMethods: ["terminal.open"],
          methodResponses: {
            "terminal.list": { sessions: [] },
            "terminal.open": {
              agentId: "main",
              confined: false,
              cwd: "/workspace",
              sessionId: "font-proof",
              shell: "/bin/zsh",
            },
          },
        });
        await page.goto(suite.server.baseUrl + "activity");
        await waitForControlUiGatewayReady(page);
        await waitForControlUiTerminalReady(page);
        await page.keyboard.press("Control+Backquote");
        await gateway.waitForRequest("terminal.open");
        const canvas = page.locator(".tp-host canvas");
        await canvas.waitFor();
        const output =
          "\x1b[?25l\x1b[1m  OpenClaw · ZSH prompt\x1b[0m\r\n\r\n" +
          "\x1b[30;46m \uf007 jacob@workstation \x1b[36;44m\ue0b0\x1b[37m \uf07b ~/workspace \x1b[34;42m\ue0b0\x1b[30m \ue0a0 main \x1b[32;49m\ue0b0\x1b[0m\r\n" +
          "\x1b[32m❯\x1b[0m git status\r\nOn branch main\r\nNothing to commit, working tree clean\r\n\r\n" +
          "Nerd Font symbols   \uf013  \uf120  \uf17c  \uf121  \udb80\udf44  \ue0b0 \ue0b2\r\n" +
          "\x1b[1mBold icons          \uf013  \uf120  \uf17c  \uf121  \udb80\udf44\x1b[0m\r\n" +
          "Text                café  naïve  λ  →  日本語\r\n" +
          "Operators           !=  ===  =>  ->  <=\r\n";
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
        await expect
          .poll(() =>
            page.evaluate(() =>
              [...document.fonts].some(
                (font) => font.family.includes("OpenClaw Nerd Symbols") && font.status === "loaded",
              ),
            ),
          )
          .toBe(true);
        await expect
          .poll(() => canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL()))
          .not.toBe(fallbackPixels);
        const frame = await takeControlUiScreenshotFrame(page, canvas, [canvas], {
          animations: "disabled",
        });
        await fs.writeFile(path.join(suite.artifactDir, "terminal.png"), frame.png);
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
        const typography = settings.locator("#settings-appearance-typography");
        const settingsFrame = await takeControlUiScreenshotFrame(settings, typography, [input], {
          animations: "disabled",
          scrollTo: typography,
        });
        await fs.writeFile(path.join(suite.artifactDir, "settings.png"), settingsFrame.png);
        await settings.reload();
        await input.waitFor();
        expect(await input.inputValue()).toBe("DejaVu Sans Mono");
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
        await settings.reload();
        await input.waitFor();
        expect(await input.inputValue()).toBe("");
        await settings.close();
      },
    );
  });
  it("keeps the main terminal usable when the bundled font download fails", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/symbols-nerd-font-mono.woff2*", (route) => route.abort());
      const gateway = await installMockGateway(page, {
        terminalEnabled: true,
        featureMethods: ["terminal.open"],
        methodResponses: {
          "terminal.list": { sessions: [] },
          "terminal.open": {
            agentId: "main",
            confined: false,
            cwd: "/workspace",
            sessionId: "failed-font",
            shell: "/bin/zsh",
          },
        },
      });
      await page.goto(suite.server.baseUrl + "terminal");
      await gateway.waitForRequest("terminal.open");
      const canvas = page.locator(".tp-host canvas");
      await canvas.waitFor();
      await expect
        .poll(() =>
          page.evaluate(() =>
            [...document.fonts].some(
              (font) => font.family.includes("OpenClaw Nerd Symbols") && font.status === "error",
            ),
          ),
        )
        .toBe(true);
      await canvas.click();
      await page.keyboard.type("echo still-usable");
      await expect
        .poll(async () => (await gateway.getRequests("terminal.input")).length)
        .toBeGreaterThan(0);
      expect(await gateway.getRequests("terminal.open")).toHaveLength(1);
      expect(errors).toEqual([]);
    });
  });
});
