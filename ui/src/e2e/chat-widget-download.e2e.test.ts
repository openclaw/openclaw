import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { useCanvasSandboxFixture } from "./canvas-sandbox.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Widget download outcome",
  startServerBeforeBrowser: true,
});
suite.define(() => {
  const canvasView = useCanvasSandboxFixture();
  it("reports an HTML download handoff without claiming the browser saved it", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, colorScheme: "light", acceptDownloads: false },
      async ({ page }) => {
        const sessionKey = "agent:main:dashboard:widget-download";
        // Older stored documents have no snapshot bridge, so the real exporter times out.
        const html =
          "<!doctype html><title>Weekly check-in</title><h2>Weekly check-in</h2><p>Three decisions ready for review.</p>";
        const gateway = await installMockGateway(page, {
          sessionKey,
          authMethod: "trusted-proxy",
          authMode: "trusted-proxy",
          methodResponses: { "canvas.document.view": canvasView(html) },
          historyMessages: [
            {
              role: "assistant",
              content: [
                { type: "text", text: '[embed ref="download-proof" title="Weekly check-in" /]' },
              ],
              timestamp: 1_800_000_000_000,
            },
          ],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await page
          .locator(".chat-tool-card__preview-frame")
          .contentFrame()
          .frameLocator("iframe")
          .getByText("Three decisions ready for review.")
          .waitFor();
        const actions = page.getByRole("button", { name: "Widget actions", exact: true });
        await actions.focus();
        await actions.press("Enter");
        const downloading = page.waitForEvent("download");
        await page.getByRole("menuitem", { name: "Download as image", exact: true }).click();
        const download = await downloading;
        expect(download.suggestedFilename()).toBe("Weekly-check-in.html");
        expect(await download.failure()).toContain("acceptDownloads");
        const notice = page.locator(".app-toast").filter({ hasText: "Image unavailable." });
        await notice.waitFor();
        const frame = await takeControlUiScreenshotFrame(page, notice, [notice], {
          animations: "disabled",
          elements: [notice],
        });
        await writeFile(path.join(suite.artifactDir, "handoff.png"), frame.png);
        expect(await notice.locator(".app-toast__description").textContent()).toBe(
          "HTML download started instead. Check your browser downloads.",
        );
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      },
    );
  });
});
