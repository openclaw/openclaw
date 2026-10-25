import { readFileSync } from "node:fs";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { scrollChatThreadToTop, waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import {
  exactButton,
  polledAttribute,
  polledClipboard,
  polledCount,
} from "./chat-presentation.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat content context copy" });
const userMarkdown = "Please preserve **this formatting**.\n\nSecond paragraph.";
const code =
  "\n  const lines = [\n" +
  ["first", "second", "third", "fourth", "fifth", "sixth", "<copy>", "café"]
    .map((line) => `    "${line}",`)
    .join("\n") +
  "\n  ];\n\tconsole.log(lines);\n  ";
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

const message = (role: string, id: string, seq: number, content: unknown[]) => ({
  role,
  content,
  timestamp: 1_700_000_000_000 + (seq - 1) * 1000,
  __openclaw: { id, seq },
});
const attachment = (kind: string, label: string, mimeType: string, url: string) => ({
  type: "attachment",
  attachment: { kind, label, mimeType, url },
});

async function withClipboard(run: (page: Page) => Promise<void>) {
  await suite.withPage(createControlUiE2eContextOptions(), async ({ context, page }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(suite.server.baseUrl).origin,
    });
    await run(page);
  });
}

suite.define(() => {
  it.each(["unavailable", "rejecting"])(
    "copies expanded-table TSV when clipboard.writeText is %s",
    async (clipboardMode) => {
      await withClipboard(async (page) => {
        await installMockGateway(page, {
          historyMessages: [
            message("assistant", "fallback-copy-table", 1, [{ type: "text", text: tableMarkdown }]),
          ],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await exactButton(page, "Expand table").click();
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
        await polledClipboard(page).toBe(tableText);
        await polledCount(menu).toBe(0);
        expect(await expandedTable.isVisible()).toBe(true);
        await exactButton(expandedTable, "Close expanded table").click();
        await expandedTable.waitFor({ state: "detached" });
      });
    },
  );

  it("copies clicked chat content through the browser clipboard and preserves native controls", async () => {
    await withClipboard(async (page) => {
      const gateway = await installMockGateway(page, {
        historyMessages: [
          message("user", "copy-user", 1, [
            { type: "text", text: userMarkdown },
            attachment("document", "notes.txt", "text/plain", fileUrl),
          ]),
          message("assistant", "copy-assistant", 2, [
            { type: "text", text: assistantMarkdown },
            { type: "image", data: imageData, mimeType: "image/png", alt: "Copy boundary image" },
            attachment("video", "copy-boundary.mp4", "video/mp4", videoUrl),
          ]),
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await scrollChatThreadToTop(page);
      await waitForChatScrollIdle(page);
      const user = page.locator('.chat-bubble[data-entry-id="copy-user"]');
      const assistant = page.locator('.chat-bubble[data-entry-id="copy-assistant"]');
      const menu = page.locator(".chat-reply-context-menu");
      const copy = async (target: Locator, label: string, text: string) => {
        await target.click({ button: "right" });
        await menu.waitFor({ state: "visible" });
        await menu.getByRole("menuitem", { name: label, exact: true }).click();
        await polledClipboard(page).toBe(text);
        await polledCount(menu).toBe(0);
      };

      await copy(user.locator(".chat-text p").first(), "Copy as markdown", userMarkdown);

      const codeBlock = assistant.locator(".code-block-wrapper");
      const expandCode = codeBlock.getByRole("button", { name: /Show \d+ hidden lines/ });
      expect(await expandCode.getAttribute("aria-expanded")).toBe("false");
      await copy(codeBlock.locator(".code-block-viewport"), "Copy code", code);

      const table = assistant.locator(".markdown-table");
      await copy(table.locator("td").first(), "Copy table", tableText);
      await exactButton(table, "Expand table").click();
      const expandedTable = page.locator(".markdown-table-dialog");
      await expandedTable.waitFor({ state: "visible" });
      await copy(expandedTable.locator("td").first(), "Copy table", tableText);
      await exactButton(expandedTable, "Close expanded table").click();
      await expandedTable.waitFor({ state: "detached" });

      const prose = assistant.getByText(selectionParagraph, { exact: true });
      await prose.scrollIntoViewIfNeeded();
      const selectionPoint = await prose.evaluate((element) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let text = walker.nextNode();
        while (text && !text.textContent?.includes("these words")) {
          text = walker.nextNode();
        }
        if (!text) {
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
      await polledClipboard(page).toBe("these words");
      await polledCount(menu).toBe(0);
      await page.evaluate(() => window.getSelection()?.removeAllRanges());

      await copy(
        user.locator(".chat-assistant-attachment-card__title"),
        "Copy link",
        new URL(fileUrl, suite.server.baseUrl).href,
      );

      for (const control of [
        assistant.locator('input[type="checkbox"]'),
        assistant.getByRole("link", { name: "Reference", exact: true }),
        assistant.getByAltText("Copy boundary image"),
        assistant.locator("video"),
      ]) {
        // Center read-only controls above the floating composer before forced pointer input.
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
        await polledAttribute(control, "data-context-menu-prevented").toBe("false");
        expect(await control.getAttribute("data-context-menu-trusted")).toBe("true");
        expect(await menu.count()).toBe(0);
        await page.keyboard.press("Escape");
      }
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });
});
