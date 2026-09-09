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

  it("keeps user files outside the painted text and preserves column rhythm", async () => {
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
      expect(
        await page
          .locator(".chat-group.user .chat-bubble")
          .evaluate((node) => getComputedStyle(node).backgroundColor),
      ).toBe("rgba(0, 0, 0, 0)");
      const reference = await gap(paragraphs.nth(0), paragraphs.nth(1));
      for (let index = 1; index < count; index += 1) {
        expect(
          Math.abs((await gap(cards.nth(index - 1), cards.nth(index))) - reference),
        ).toBeLessThanOrEqual(1);
      }
      expect(
        Math.abs((await gap(cards.last(), page.locator(".chat-text"))) - reference),
      ).toBeLessThanOrEqual(1);
      expect(
        await page
          .locator(".chat-thread")
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
    });
  });

  it.each([
    { self: true, name: "own" },
    { self: false, name: "peer" },
  ])("aligns visible media with the $name participant's text bubble", async ({ self }) => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const url = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 360;
        return canvas.toDataURL();
      });
      const users = ["Riley", "Colin"].map((name, index) => ({
        id: name,
        name,
        self: index === 0,
        identity: { type: "profile" as const, id: name },
      }));
      const sender = users[self ? 0 : 1]!;
      await installMockGateway(page, {
        presenceUsers: users,
        historyMessages: [
          {
            role: "user",
            content: [
              { type: "image", url },
              attachment(),
              {
                type: "text",
                text: "Please compare the screenshot and attached logs with the expected release notes.",
              },
            ],
            __openclaw: {
              senderId: sender.id,
              senderIdentity: sender.identity,
              senderName: sender.name,
            },
          },
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat/main`);
      const group = page.locator(".chat-group.user");
      await group.locator(".chat-text").waitFor();
      await group
        .locator("img.chat-message-image")
        .evaluate((node: HTMLImageElement) => node.decode());
      const layout = await group.evaluate((node) => {
        const text = node.querySelector(".chat-text")!;
        const rect = (element: Element) => {
          const { left, right, top, bottom } = element.getBoundingClientRect();
          return { left, right, top, bottom };
        };
        return {
          shellPaint: getComputedStyle(node.querySelector(".chat-bubble")!).backgroundColor,
          textPaint: getComputedStyle(text).backgroundColor,
          text: rect(text),
          media: [
            ...node.querySelectorAll(".chat-message-image, .chat-assistant-attachment-card"),
          ].map(rect),
        };
      });
      expect(layout.shellPaint).toBe("rgba(0, 0, 0, 0)");
      expect(layout.textPaint).not.toBe("rgba(0, 0, 0, 0)");
      expect(layout.media).toHaveLength(2);
      const edge = self ? "right" : "left";
      for (const media of layout.media) {
        expect(Math.abs(media[edge] - layout.text[edge])).toBeLessThanOrEqual(1);
        expect(media.bottom).toBeLessThan(layout.text.top);
      }
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
        [card, text],
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
