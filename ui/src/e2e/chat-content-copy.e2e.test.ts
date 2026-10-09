import { readFileSync } from "node:fs";
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat content context copy" });
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const userMarkdown = "Please preserve **this formatting**.\n\nSecond paragraph.";
const code = [
  "",
  "  const lines = [",
  '    "first",',
  '    "second",',
  '    "third",',
  '    "fourth",',
  '    "fifth",',
  '    "sixth",',
  '    "<copy>",',
  '    "café",',
  "  ];",
  "\tconsole.log(lines);",
  "  ",
].join("\n");
const tableMarkdown = "| Name | Value |\n| --- | --- |\n| alpha | 1 |\n| café | `<ready>` |";
const tableText = "Name\tValue\nalpha\t1\ncafé\t<ready>";
const selectionParagraph = "Select just these words for the clipboard.";
const assistantMarkdown = [
  selectionParagraph,
  `\`\`\`ts\n${code}\n\`\`\``,
  tableMarkdown,
  "[Reference](https://example.com/copy-reference)",
  "- [ ] Keep this item unchecked",
].join("\n\n");
const fileUrl = "/__openclaw__/assistant-media?source=notes.txt&mediaTicket=copy-proof";
const imageData =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";
const videoUrl = `data:video/mp4;base64,${readFileSync(
  new URL("./fixtures/video-poster.mp4", import.meta.url),
).toString("base64")}`;

suite.define(() => {
  it.each(["unavailable", "rejecting"])(
    "copies expanded-table TSV when clipboard.writeText is %s",
    async (clipboardMode) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ context, page }) => {
        await context.grantPermissions(["clipboard-read", "clipboard-write"], {
          origin: new URL(suite.server.baseUrl).origin,
        });
        await installMockGateway(page, {
          historyMessages: [
            {
              role: "assistant",
              content: [{ type: "text", text: tableMarkdown }],
              timestamp: 1_700_000_000_000,
              __openclaw: { id: "fallback-copy-table", seq: 1 },
            },
          ],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.getByRole("button", { name: "Expand table", exact: true }).click();
        const expandedTable = page.locator(".markdown-table-dialog");
        await expandedTable.waitFor({ state: "visible" });
        await page.evaluate(async (mode) => {
          await navigator.clipboard.writeText("Before modal fallback copy.");
          // Only the modern write transport is faulted. execCommand and readText stay real.
          Object.defineProperty(navigator.clipboard, "writeText", {
            configurable: true,
            value:
              mode === "unavailable"
                ? undefined
                : async () => {
                    throw new DOMException("Clipboard write denied", "NotAllowedError");
                  },
          });
        }, clipboardMode);

        await expandedTable.locator("td").first().click({ button: "right" });
        const menu = page.locator(".chat-reply-context-menu");
        await menu.getByRole("menuitem", { name: "Copy table", exact: true }).click();
        await expect
          .poll(() => page.evaluate(() => navigator.clipboard.readText()))
          .toBe(tableText);
        await expect.poll(() => menu.count()).toBe(0);
        expect(await expandedTable.isVisible()).toBe(true);
        await expandedTable
          .getByRole("button", { name: "Close expanded table", exact: true })
          .click();
        await expandedTable.waitFor({ state: "detached" });
      });
    },
  );

  it("copies clicked chat content through the browser clipboard and preserves native controls", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ context, page }) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: new URL(suite.server.baseUrl).origin,
      });
      const gateway = await installMockGateway(page, {
        historyMessages: [
          {
            role: "user",
            content: [
              { type: "text", text: userMarkdown },
              {
                type: "attachment",
                attachment: {
                  kind: "document",
                  label: "notes.txt",
                  mimeType: "text/plain",
                  url: fileUrl,
                },
              },
            ],
            timestamp: 1_700_000_000_000,
            __openclaw: { id: "copy-user", seq: 1 },
          },
          {
            role: "assistant",
            content: [
              { type: "text", text: assistantMarkdown },
              { type: "image", data: imageData, mimeType: "image/png", alt: "Copy boundary image" },
              {
                type: "attachment",
                attachment: {
                  kind: "video",
                  label: "copy-boundary.mp4",
                  mimeType: "video/mp4",
                  url: videoUrl,
                },
              },
            ],
            timestamp: 1_700_000_001_000,
            __openclaw: { id: "copy-assistant", seq: 2 },
          },
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      const user = page.locator('.chat-bubble[data-entry-id="copy-user"]');
      const assistant = page.locator('.chat-bubble[data-entry-id="copy-assistant"]');
      const menu = page.locator(".chat-reply-context-menu");
      const expectClipboard = async (text: string) => {
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(text);
        await expect.poll(() => menu.count()).toBe(0);
      };
      const copyFromContextMenu = async (
        target: Locator,
        label: string,
        text: string,
        proofName?: string,
      ) => {
        await target.click({ button: "right" });
        await menu.waitFor({ state: "visible" });
        if (captureProof && proofName) {
          await page.screenshot({
            animations: "disabled",
            path: path.join(suite.artifactDir, `${proofName}.png`),
          });
        }
        await menu.getByRole("menuitem", { name: label, exact: true }).click();
        await expectClipboard(text);
      };

      await copyFromContextMenu(
        user.locator(".chat-text p").first(),
        "Copy as markdown",
        userMarkdown,
      );

      const codeBlock = assistant.locator(".code-block-wrapper");
      expect(
        await codeBlock
          .getByRole("button", { name: /Show \d+ hidden lines/ })
          .getAttribute("aria-expanded"),
      ).toBe("false");
      await copyFromContextMenu(
        codeBlock.locator(".code-block-viewport"),
        "Copy code",
        code,
        "collapsed-code-menu",
      );

      const table = assistant.locator(".markdown-table");
      await copyFromContextMenu(table.locator("td").first(), "Copy table", tableText);
      await table.getByRole("button", { name: "Expand table", exact: true }).click();
      const expandedTable = page.locator(".markdown-table-dialog");
      await expandedTable.waitFor({ state: "visible" });
      await copyFromContextMenu(
        expandedTable.locator("td").first(),
        "Copy table",
        tableText,
        "expanded-table-menu",
      );
      await expandedTable
        .getByRole("button", { name: "Close expanded table", exact: true })
        .click();
      await expandedTable.waitFor({ state: "detached" });

      const prose = assistant.getByText(selectionParagraph, { exact: true });
      await prose.scrollIntoViewIfNeeded();
      const selectionPoint = await prose.evaluate((element) => {
        const text = element.firstChild;
        if (!text || text.nodeType !== Node.TEXT_NODE) {
          throw new Error("Expected rendered selection paragraph text");
        }
        const start = text.textContent!.indexOf("these words");
        const range = document.createRange();
        range.setStart(text, start);
        range.setEnd(text, start + "these words".length);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        const bounds = range.getBoundingClientRect();
        return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      });
      await page.mouse.click(selectionPoint.x, selectionPoint.y, { button: "right" });
      await menu.getByRole("menuitem", { name: "Copy", exact: true }).click();
      await expectClipboard("these words");
      await page.evaluate(() => window.getSelection()?.removeAllRanges());

      await copyFromContextMenu(
        user.locator(".chat-assistant-attachment-card__title"),
        "Copy link",
        new URL(fileUrl, suite.server.baseUrl).href,
      );

      // Observe after propagation so an ancestor cannot silently replace the native menu.
      for (const control of [
        assistant.locator('input[type="checkbox"]'),
        assistant.getByRole("link", { name: "Reference", exact: true }),
        assistant.getByAltText("Copy boundary image"),
        assistant.locator("video"),
      ]) {
        // The floating composer covers the viewport edge; forced clicks need
        // the actual control centered above it, not merely inside the viewport.
        await control.evaluate((element) => element.scrollIntoView({ block: "center" }));
        await control.evaluate((element) => {
          element.addEventListener(
            "contextmenu",
            (event) => {
              setTimeout(() => {
                element.setAttribute("data-context-menu-prevented", String(event.defaultPrevented));
                element.setAttribute("data-context-menu-trusted", String(event.isTrusted));
              }, 0);
            },
            { capture: true, once: true },
          );
        });
        // Task checkboxes are read-only. Force bypasses enabled-state waiting, not pointer input.
        await control.click({ button: "right", force: true });
        await expect.poll(() => control.getAttribute("data-context-menu-prevented")).toBe("false");
        expect(await control.getAttribute("data-context-menu-trusted")).toBe("true");
        expect(await menu.count()).toBe(0);
        await page.keyboard.press("Escape");
      }
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });
});
