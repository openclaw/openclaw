import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Chat attachment block spacing",
  startServerBeforeBrowser: true,
});

const neighbors = [
  { name: "paragraph", markdown: "A paragraph after the file." },
  { name: "heading", markdown: "## A heading after the file" },
  { name: "list", markdown: "- First item\n- Second item" },
  { name: "code", markdown: "```js\nconst ready = true;\n```" },
  { name: "table", markdown: "| Item | Status |\n| --- | --- |\n| Report | Ready |" },
  { name: "quote", markdown: "> A quotation after the file." },
];

function attachment(index = 0) {
  return {
    type: "attachment",
    attachment: {
      kind: "document",
      label: `report-${index}.txt`,
      mimeType: "text/plain",
      url: `https://example.com/report-${index}.txt`,
      sizeBytes: 1024,
    },
  };
}

async function gap(above: Locator, below: Locator) {
  const upper = await above.boundingBox();
  const lower = await below.boundingBox();
  if (!upper || !lower) {
    throw new Error("Both neighboring blocks must be rendered");
  }
  return lower.y - upper.y - upper.height;
}

suite.define(() => {
  for (const width of [1440, 390]) {
    it.each(neighbors)(
      `matches paragraph rhythm before $name at ${width}px`,
      async ({ markdown }) => {
        await suite.withPage({ viewport: { width, height: 900 } }, async ({ page }) => {
          await installMockGateway(page, {
            historyMessages: [
              {
                role: "assistant",
                content: [
                  attachment(),
                  { type: "text", text: `${markdown}\n\nReference one.\n\nReference two.` },
                ],
              },
            ],
          });
          await page.goto(`${suite.server.baseUrl}chat/main`);
          const bubble = page.locator(".chat-bubble").filter({ hasText: "Reference one." });
          const card = bubble.locator(".chat-assistant-attachment-card");
          const blocks = bubble.locator(".chat-text > *");
          await blocks.last().waitFor();
          const reference = await gap(blocks.nth(1), blocks.nth(2));
          expect(reference).toBeGreaterThan(0);
          await expect
            .poll(async () =>
              Math.max(
                Math.abs((await gap(card, blocks.first())) - reference),
                Math.abs((await gap(blocks.first(), blocks.nth(1))) - reference),
              ),
            )
            .toBeLessThanOrEqual(1);
        });
      },
    );
  }

  it("keeps multiple files in a column with the text rhythm on mobile", async () => {
    const count = 5;
    await suite.withPage({ viewport: { width: 390, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, {
        historyMessages: [
          {
            role: "user",
            content: [
              ...Array.from({ length: count }, (_, index) => attachment(index)),
              { type: "text", text: "Reference one.\n\nReference two." },
            ],
          },
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat/main`);
      const cards = page.locator(".chat-assistant-attachment-card");
      const paragraphs = page.locator(".chat-text > p");
      await paragraphs.last().waitFor();
      await expect.poll(() => cards.count()).toBe(count);
      const reference = await gap(paragraphs.nth(0), paragraphs.nth(1));
      for (let index = 1; index < count; index += 1) {
        expect(
          Math.abs((await gap(cards.nth(index - 1), cards.nth(index))) - reference),
        ).toBeLessThanOrEqual(1);
      }
      expect(
        Math.abs((await gap(cards.last(), paragraphs.first())) - reference),
      ).toBeLessThanOrEqual(1);
      expect(
        await page
          .locator(".chat-thread")
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
    });
  });

  it("preserves nested user fences while sharing the top-level attachment rhythm", async () => {
    await suite.withPage({ viewport: { width: 390, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, {
        historyMessages: [
          {
            role: "user",
            content: [
              attachment(),
              {
                type: "text",
                text: "```txt\ntop level\n```\n\nReference one.\n\nReference two.\n\n> Before code.\n>\n> ```txt\n> nested code\n> ```\n>\n> After code.",
              },
            ],
          },
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat/main`);
      const text = page.locator(".chat-text");
      const nestedCode = text.locator("blockquote pre");
      await nestedCode.waitFor();
      const reference = await gap(
        text.locator(":scope > p").nth(0),
        text.locator(":scope > p").nth(1),
      );
      const card = page.locator(".chat-assistant-attachment-card");
      for (const [above, below] of [
        [card, text.locator(":scope > pre")],
        [text.locator("blockquote > p").first(), nestedCode],
        [nestedCode, text.locator("blockquote > p").last()],
      ] as const) {
        expect(Math.abs((await gap(above, below)) - reference)).toBeLessThanOrEqual(1);
      }
    });
  });

  it("shares the block rhythm inside expanded tool output", async () => {
    await suite.withPage({ viewport: { width: 390, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, {
        historyMessages: [
          {
            role: "user",
            content: [{ type: "text", text: "Reference one.\n\nReference two." }],
          },
          {
            role: "toolResult",
            toolCallId: "spacing-preview",
            toolName: "image",
            content: [
              attachment(),
              {
                type: "image",
                url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=",
                alt: "Generated preview",
              },
              { type: "text", text: "Generated output." },
            ],
          },
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat/main`);
      await page.locator(".chat-tool-msg-summary").first().click();
      const body = page.locator(".chat-tool-msg-body");
      const text = body.locator(":scope > .chat-text");
      await text.waitFor();
      const paragraphs = page.locator(".chat-group.user .chat-text > p");
      await paragraphs.last().waitFor();
      const reference = await gap(paragraphs.nth(0), paragraphs.nth(1));
      const attachments = body.locator(":scope > .chat-assistant-attachments");
      expect(Math.abs((await gap(attachments, text)) - reference)).toBeLessThanOrEqual(1);
      expect(
        Math.abs(
          (await gap(body.locator(":scope > .chat-message-images"), attachments)) - reference,
        ),
      ).toBeLessThanOrEqual(1);
    });
  });
});
