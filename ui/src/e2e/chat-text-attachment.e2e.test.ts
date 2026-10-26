import { readFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { expect, it } from "vitest";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.ts";
import { newChatPage } from "./chat-flow-fixtures.test-support.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const text =
  "Release checklist\n\nRead the attached notes without leaving the conversation.\n\n  Keep indentation and line breaks.\n  Unicode text: café 🦞\n\n<script>Displayed as text, never executed.</script>\n" +
  "\n## Step\n\nReview the notes before continuing.\n".repeat(40) +
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
      const { context, page } = await newChatPage(suite, { viewport: { width, height: 900 } });
      const filename = `pasted-notes.${extension}`;
      const mediaUrl = `/__openclaw__/assistant-media?source=${filename}&mediaTicket=text-preview`;
      const reads: Array<{ url: string; authorization: string | undefined }> = [];
      let downloads = 0;
      page.on("download", () => {
        downloads += 1;
      });
      const attachment = { kind: "document", label: filename, mimeType, url: mediaUrl };
      const gateway = await installMockGateway(page, {
        historyMessages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Please review these notes." },
              { type: "attachment", attachment },
            ],
          },
        ],
      });
      // Native downloads bypass Playwright routing. Keep preview and download on
      // one real same-origin endpoint, proxying the unchanged production UI.
      const server = await reserveTestPortListener({
        offsets: [0],
        createListener: () =>
          createServer((req, res) => {
            if (req.url?.startsWith("/__openclaw__/assistant-media?")) {
              reads.push({ url: req.url, authorization: req.headers.authorization });
              res.writeHead(200, {
                "content-type": `${mimeType}; charset=utf-8`,
                "content-disposition": `attachment; filename="${filename}"`,
                "content-length": Buffer.byteLength(text),
              });
              res.end(text);
              return;
            }
            const upstream = request(
              new URL(req.url ?? "/", suite.server.baseUrl),
              {
                method: req.method,
                headers: { ...req.headers, host: new URL(suite.server.baseUrl).host },
              },
              (response) => {
                res.writeHead(response.statusCode ?? 502, response.headers);
                response.pipe(res);
              },
            );
            upstream.on("error", () => res.destroy());
            res.once("close", () => upstream.destroy());
            req.pipe(upstream);
          }),
      });
      const baseUrl = `http://127.0.0.1:${server.claim.port}/`;
      try {
        await page.goto(`${baseUrl}chat`);
        await gateway.waitForRequest("sessions.messages.subscribe");
        const card = page
          .locator(".chat-assistant-attachment-card--compact")
          .filter({ hasText: filename });
        await card
          .getByRole("button", { name: `Open ${filename} in the side panel`, exact: true })
          .click();
        const panel = page.locator("openclaw-chat-detail-panel:visible");
        const reader = panel.locator(extension === "md" ? "article" : "pre");
        await reader.waitFor();
        const downloadAction = panel.getByRole("link", {
          name: `Download ${filename}`,
          exact: true,
        });
        await expect.poll(() => downloadAction.count()).toBe(1);
        await downloadAction.waitFor();
        const scroller = width === 390 ? reader : panel.locator(".sidebar-content");
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
          await scroller.evaluate((element) => {
            const end = "End of the release checklist.";
            const textNodes = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            for (let node = textNodes.nextNode(); node; node = textNodes.nextNode()) {
              const start = node.textContent?.indexOf(end) ?? -1;
              if (start < 0) {
                continue;
              }
              const range = document.createRange();
              range.setStart(node, start);
              range.setEnd(node, start + end.length);
              const lastLine = range.getBoundingClientRect();
              const viewport = element.getBoundingClientRect();
              return (
                lastLine.top >= Math.max(viewport.top, 0) &&
                lastLine.bottom <= Math.min(viewport.bottom, window.innerHeight)
              );
            }
            return false;
          }),
        ).toBe(true);
        if (extension === "md") {
          await scroller.evaluate((element) => {
            element.scrollTop = 0;
          });
          await panel.getByRole("button", { name: "View Raw Text", exact: true }).click();
        }
        expect(await panel.locator("pre").textContent()).toBe(text);
        expect(await panel.locator("script, iframe").count()).toBe(0);
        expect(downloads).toBe(0);
        expect(reads).toEqual([{ url: mediaUrl, authorization: undefined }]);
        expect(
          await panel
            .locator("pre")
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
        const [download] = await Promise.all([
          page.waitForEvent("download"),
          downloadAction.click(),
        ]);
        expect(download.suggestedFilename()).toBe(filename);
        expect(await download.failure()).toBeNull();
        const downloadedPath = await download.path();
        expect(downloadedPath).not.toBeNull();
        expect(await readFile(downloadedPath!)).toEqual(Buffer.from(text, "utf8"));
        expect(downloads).toBe(1);
        expect(reads).toEqual([
          { url: mediaUrl, authorization: undefined },
          { url: mediaUrl, authorization: undefined },
        ]);
      } finally {
        try {
          await suite.closeBrowserContext(context);
        } finally {
          server.listener.closeAllConnections();
          await server.releaseListener();
          await server.claim.release();
        }
      }
    },
  );
});
