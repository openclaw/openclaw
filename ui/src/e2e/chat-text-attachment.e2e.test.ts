import path from "node:path";
import { expect, it } from "vitest";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
const text =
  "Release checklist\n\nRead the attached notes without leaving the conversation.\n\n  Keep indentation and line breaks.\n  Unicode text: café 🦞\n\n<script>Displayed as text, never executed.</script>\n" +
  Array.from(
    { length: 40 },
    (_, index) => `\n## Step ${index + 1}\n\nReview the notes before continuing.\n`,
  ).join("") +
  "\nEnd of the release checklist.\n";

suite.define(() => {
  it.each([
    { width: 1280, extension: "txt", mimeType: "text/plain" },
    { width: 390, extension: "txt", mimeType: "text/plain" },
    { width: 1280, extension: "md", mimeType: "text/markdown" },
    { width: 390, extension: "md", mimeType: "text/markdown" },
  ])(
    "scrolls a long $extension file in the side panel at $width px and keeps download available",
    async ({ width, extension, mimeType }) => {
      const context = await suite.newBrowserContext({
        ...createControlUiE2eContextOptions(),
        viewport: { width, height: 900 },
      });
      const page = await context.newPage();
      const filename = `pasted-notes.${extension}`;
      const mediaUrl = `/__openclaw__/assistant-media?source=${filename}&mediaTicket=text-preview`;
      let reads = 0;
      let downloads = 0;
      page.on("download", () => {
        downloads += 1;
      });
      await page.route("**/__openclaw__/assistant-media?**", async (route) => {
        reads += 1;
        expect(route.request().headers().authorization).toBeUndefined();
        await route.fulfill({
          contentType: `${mimeType}; charset=utf-8`,
          headers: { "Content-Disposition": `attachment; filename="${filename}"` },
          body: text,
        });
      });
      const gateway = await installMockGateway(page, {
        historyMessages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Please review these notes." },
              {
                type: "attachment",
                attachment: {
                  kind: "document",
                  label: filename,
                  mimeType,
                  url: mediaUrl,
                },
              },
            ],
            timestamp: Date.now(),
          },
        ],
      });
      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("chat.startup");
        const card = page
          .locator(".chat-assistant-attachment-card--compact")
          .filter({ hasText: filename });
        await card
          .getByRole("button", { name: `Open ${filename} in the side panel`, exact: true })
          .click();
        const panel = page.locator("openclaw-chat-detail-panel:visible");
        await panel.locator("a[download]").waitFor();
        const reader = panel.locator(extension === "md" ? "article" : "pre");
        await reader.waitFor();
        await page.screenshot({
          path: path.join(suite.artifactDir, `${extension}-preview-${width}.png`),
        });
        const scroller = panel.locator(".sidebar-content");
        expect(
          await scroller.evaluate((element) => element.clientHeight < element.scrollHeight),
        ).toBe(true);
        await scroller.hover();
        await page.mouse.wheel(0, 600);
        await expect
          .poll(() => scroller.evaluate((element) => element.scrollTop))
          .toBeGreaterThan(0);
        await scroller.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        expect(
          await reader.evaluate((element) => {
            const bottom = element.getBoundingClientRect().bottom;
            const viewport = element.closest(".sidebar-content")!.getBoundingClientRect();
            return bottom <= viewport.bottom && bottom > viewport.top;
          }),
        ).toBe(true);
        await page.screenshot({
          path: path.join(suite.artifactDir, `${extension}-preview-${width}-bottom.png`),
        });
        if (extension === "md") {
          await scroller.evaluate((element) => {
            element.scrollTop = 0;
          });
          await panel.getByRole("button", { name: "View Raw Text", exact: true }).click();
        }
        expect(await panel.locator("pre").textContent()).toBe(text);
        expect(await panel.locator("script, iframe").count()).toBe(0);
        expect(downloads).toBe(0);
        expect(reads).toBe(1);
        expect(
          await panel
            .locator("pre")
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
        await page.screenshot({
          path: path.join(suite.artifactDir, `${extension}-preview-${width}-readable.png`),
        });
        const [download] = await Promise.all([
          page.waitForEvent("download"),
          panel.locator("a[download]").click(),
        ]);
        expect(download.suggestedFilename()).toBe(filename);
        expect(await download.failure()).toBeNull();
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
