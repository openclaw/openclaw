import { readFileSync } from "node:fs";
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

  it("keeps user files above the painted text bubble without changing assistant cards", async () => {
    const count = 5;
    for (const width of [1440, 390]) {
      await suite.withPage({ viewport: { width, height: 900 } }, async ({ page }) => {
        await installMockGateway(page, {
          historyMessages: [
            {
              role: "user",
              content: [
                ...Array.from({ length: count }, (_, index) => attachment(index)),
                { type: "text", text: "Reference one.\n\nReference two." },
              ],
            },
            {
              role: "assistant",
              content: [attachment(6), { type: "text", text: "Assistant reference." }],
            },
            { role: "user", content: [attachment(7)] },
          ],
        });
        await page.goto(`${suite.server.baseUrl}chat/main`);
        const user = page.locator(".chat-group.user").first();
        const cards = user.locator(".chat-assistant-attachment-card");
        const paragraphs = user.locator(".chat-text > p");
        await paragraphs.last().waitFor();
        await expect.poll(() => cards.count()).toBe(count);
        const shell = user.locator(".chat-bubble");
        const text = user.locator(".chat-text");
        const background = (element: Locator) =>
          element.evaluate((node) => getComputedStyle(node).backgroundColor);
        expect(await background(shell)).toBe("rgba(0, 0, 0, 0)");
        expect(await background(text)).not.toBe("rgba(0, 0, 0, 0)");
        const column = await user.locator(".chat-group-messages").boundingBox();
        const card = await cards.first().boundingBox();
        expect(column).not.toBeNull();
        expect(card).not.toBeNull();
        expect(Math.abs(card!.width - column!.width)).toBeLessThanOrEqual(1);
        expect(Math.abs(card!.x + card!.width - column!.x - column!.width)).toBeLessThanOrEqual(1);
        const assistant = page.locator(".chat-group.assistant");
        expect(await background(assistant.locator(".chat-text"))).toBe("rgba(0, 0, 0, 0)");
        expect(
          await assistant
            .locator(".chat-bubble > .chat-assistant-attachments .chat-assistant-attachment-card")
            .count(),
        ).toBe(1);
        const fileOnly = page.locator(".chat-group.user").last();
        expect(await background(fileOnly.locator(".chat-bubble"))).toBe("rgba(0, 0, 0, 0)");
        expect(await fileOnly.locator(".chat-text").count()).toBe(0);
        const reference = await gap(paragraphs.nth(0), paragraphs.nth(1));
        for (let index = 1; index < count; index += 1) {
          expect(
            Math.abs((await gap(cards.nth(index - 1), cards.nth(index))) - reference),
          ).toBeLessThanOrEqual(1);
        }
        expect(Math.abs((await gap(cards.last(), text)) - reference)).toBeLessThanOrEqual(1);
        expect(
          await page
            .locator(".chat-thread")
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
      });
    }
  });

  it.each([1440, 390])(
    "aligns shared-thread media with its author's bubble at %ipx",
    async (width) => {
      await suite.withPage({ viewport: { width, height: 900 } }, async ({ page }) => {
        const imageData = await page.evaluate(() => {
          const canvas = document.createElement("canvas");
          canvas.width = 640;
          canvas.height = 360;
          canvas.getContext("2d")!.fillRect(0, 0, 640, 360);
          return canvas.toDataURL().split(",")[1];
        });
        await page.route("**/alignment.png*", (route) =>
          route.fulfill({ contentType: "image/png", body: Buffer.from(imageData, "base64") }),
        );
        const video = readFileSync(new URL("./fixtures/video-poster.mp4", import.meta.url));
        await page.route("**/alignment.mp4", (route) => {
          const range = route
            .request()
            .headers()
            .range?.match(/^bytes=(\d+)-(\d*)$/);
          const start = Number(range?.[1] ?? 0);
          const end = range?.[2] ? Number(range[2]) : video.length - 1;
          return route.fulfill({
            status: range ? 206 : 200,
            contentType: "video/mp4",
            headers: range ? { "content-range": `bytes ${start}-${end}/${video.length}` } : {},
            body: video.subarray(start, end + 1),
          });
        });
        const image = { type: "image", url: `${suite.server.baseUrl}alignment.png` };
        const cases = [
          { name: "Image and file", media: [image, attachment()] },
          { name: "Image", media: [image] },
          {
            name: "Video",
            media: [
              {
                type: "attachment",
                attachment: {
                  kind: "video",
                  label: "alignment.mp4",
                  mimeType: "video/mp4",
                  url: `${suite.server.baseUrl}alignment.mp4`,
                },
              },
            ],
          },
          {
            name: "Gallery",
            media: Array.from({ length: 5 }, (_, index) => ({
              ...image,
              url: `${image.url}?tile=${index}`,
            })),
          },
        ];
        const users = [
          {
            self: true,
            id: "profile-riley",
            identity: { type: "profile" as const, id: "profile-riley" },
            name: "Riley",
          },
          {
            id: "profile-colin",
            identity: { type: "profile" as const, id: "profile-colin" },
            name: "Colin",
          },
        ];
        const scenarios = users.flatMap((user) =>
          cases.map((item) => ({
            name: item.name,
            media: item.media,
            user,
            text: `${user.name}: ${item.name}. Please compare the completed update steps with the expected release notes.`,
          })),
        );
        await installMockGateway(page, {
          presenceUsers: users,
          historyMessages: scenarios.flatMap(({ user, media, text }) => [
            { role: "assistant", content: [{ type: "text", text: "Share the next update." }] },
            {
              role: "user",
              content: [...media, { type: "text", text }],
              __openclaw: {
                senderId: user.id,
                senderIdentity: user.identity,
                senderName: user.name,
              },
            },
          ]),
        });
        await page.goto(`${suite.server.baseUrl}chat/main`);
        await page.locator(".chat-group.user").last().waitFor();
        await page.locator(".chat-thread").evaluate((node) => {
          node.scrollTop = 0;
        });
        for (const { user, name, text } of scenarios) {
          const group = page.locator(".chat-group.user").filter({ hasText: text });
          await group.scrollIntoViewIfNeeded();
          const previews = group.locator("img.chat-message-image");
          await expect.poll(() => previews.count()).toBe(name === "Gallery" ? 5 : 1);
          await expect
            .poll(() =>
              previews.evaluateAll((nodes) =>
                nodes.every(
                  (node) =>
                    node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0,
                ),
              ),
            )
            .toBe(true);
          expect(await group.evaluate((node) => node.classList.contains("chat-group--peer"))).toBe(
            !user.self,
          );
          expect(
            await group
              .locator(".chat-bubble")
              .evaluate((node) => getComputedStyle(node).backgroundColor),
          ).toBe("rgba(0, 0, 0, 0)");
          const bubble = await group.locator(".chat-text").boundingBox();
          const gallery = await group.locator(".chat-message-images").boundingBox();
          expect(bubble).not.toBeNull();
          expect(gallery).not.toBeNull();
          const edge = user.self ? bubble!.x + bubble!.width : bubble!.x;
          expect(
            Math.abs((user.self ? gallery!.x + gallery!.width : gallery!.x) - edge),
          ).toBeLessThanOrEqual(1);
          const bounds = await previews.evaluateAll((nodes) =>
            nodes.map((node) => ({
              left: node.getBoundingClientRect().left,
              right: node.getBoundingClientRect().right,
            })),
          );
          const visibleEdge = user.self
            ? Math.max(...bounds.map((rect) => rect.right))
            : Math.min(...bounds.map((rect) => rect.left));
          expect(Math.abs(visibleEdge - edge)).toBeLessThanOrEqual(1);
          expect(
            await gap(group.locator(".chat-message-images"), group.locator(".chat-text")),
          ).toBeGreaterThan(0);
          if (name === "Image and file") {
            const card = await group.locator(".chat-assistant-attachment-card").boundingBox();
            expect(card).not.toBeNull();
            expect(
              Math.abs((user.self ? card!.x + card!.width : card!.x) - edge),
            ).toBeLessThanOrEqual(1);
          }
          const groupBox = await group.boundingBox();
          expect(groupBox).not.toBeNull();
          expect(Math.min(...bounds.map((rect) => rect.left))).toBeGreaterThanOrEqual(
            groupBox!.x - 1,
          );
          expect(Math.max(...bounds.map((rect) => rect.right))).toBeLessThanOrEqual(
            groupBox!.x + groupBox!.width + 1,
          );
        }
      });
    },
  );

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
