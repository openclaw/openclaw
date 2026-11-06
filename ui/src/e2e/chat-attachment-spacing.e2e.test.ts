import type { Locator, Page } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import { captureControlUiE2eFailureDiagnostics } from "../test-helpers/control-ui-e2e-diagnostics.ts";
import { installControlUiE2eRendererStallProbe } from "../test-helpers/control-ui-e2e-renderer-stall.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  navigateToControlUiSession,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const spacingPages = new Map<number, Page>();
const suite = createControlUiE2eSuite({
  name: "Chat attachment block spacing",
  startServerBeforeBrowser: true,
  resources: {
    run: async () => {
      for (const width of [1440, 390]) {
        const context = await suite.newBrowserContext({ viewport: { width, height: 900 } });
        const page = await context.newPage();
        await installControlUiE2eRendererStallProbe(page);
        try {
          await installMockGateway(page, {
            sessionKey: spacingCases[0]!.sessionKey,
            sessions: spacingCases.map(({ name, sessionKey }) => ({
              key: sessionKey,
              label: name,
              kind: "direct",
              updatedAt: 1,
            })),
            sessionTranscripts: Object.fromEntries(
              spacingCases.map(({ markdown, sessionKey }) => [
                sessionKey,
                {
                  messages: [
                    message("assistant", `${markdown}\n\n${referenceText}`, [attachment()]),
                  ],
                },
              ]),
            ),
          });
          spacingPages.set(width, page);
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, spacingCases[0]!.sessionKey));
        } catch (error) {
          await captureControlUiE2eFailureDiagnostics(page, {
            error: error instanceof Error ? error : new Error(String(error)),
            label: "Chat attachment block spacing setup",
          });
          throw error;
        }
      }
    },
  },
});

const neighbors = [
  { name: "paragraph", markdown: "A paragraph after the file." },
  { name: "heading", markdown: "## A heading after the file" },
  { name: "list", markdown: "- First item\n- Second item" },
  { name: "code", markdown: "```js\nconst ready = true;\n```" },
  { name: "table", markdown: "| Item | Status |\n| --- | --- |\n| Report | Ready |" },
  { name: "quote", markdown: "> A quotation after the file." },
];
const spacingCases = neighbors.map((neighbor, index) => ({
  name: neighbor.name,
  markdown: neighbor.markdown,
  sessionKey: `agent:main:${(index + 1).toString(16).padStart(32, "0")}`,
}));
const referenceText = "Reference one.\n\nReference two.";
const textBlock = (value: string) => ({ type: "text", text: value });
const message = (role: string, value: string, attachments: unknown[] = []) => ({
  role,
  content: [...attachments, textBlock(value)],
});

function withChat(width: number, ...historyMessages: unknown[]) {
  return (check: (page: Page) => Promise<void>) =>
    suite.withPage({ viewport: { width, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, { historyMessages });
      await page.goto(`${suite.server.baseUrl}chat/main`);
      await check(page);
    });
}

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
  const upper = (await above.boundingBox())!;
  const lower = (await below.boundingBox())!;
  return lower.y - upper.y - upper.height;
}

async function expectGap(above: Locator, below: Locator, reference: number) {
  expect(Math.abs((await gap(above, below)) - reference)).toBeLessThanOrEqual(1);
}

async function paragraphGap(paragraphs: Locator) {
  await paragraphs.last().waitFor();
  return gap(paragraphs.nth(0), paragraphs.nth(1));
}

suite.define(() => {
  for (const width of [1440, 390]) {
    it.for(spacingCases)(
      `preserves attachment spacing around $name at ${width}px`,
      async ({ name, sessionKey }, testContext) => {
        const page = spacingPages.get(width)!;
        let failedClose: Promise<void> | undefined;
        const closeAfterFailure = (error: unknown) => {
          failedClose ??= (async () => {
            await captureControlUiE2eFailureDiagnostics(page, {
              error: error instanceof Error ? error : new Error(String(error)),
              label: "Chat attachment block spacing",
            });
            await suite.closeBrowserContext(page.context());
          })();
          return failedClose;
        };
        // The page belongs to the suite; native case cancellation must still close it.
        const onAbort = () => void closeAfterFailure(testContext.signal.reason).catch(() => {});
        testContext.signal.addEventListener("abort", onAbort, { once: true });
        try {
          await suite.runScenario(testContext, {
            run: async () => {
              try {
                await navigateToControlUiSession(page, sessionKey);
                const bubble = page
                  .locator('openclaw-chat-pane[aria-hidden="false"] .chat-bubble')
                  .filter({ hasText: "Reference one." });
                const card = bubble.locator(".chat-assistant-attachment-card");
                const blocks = bubble
                  .locator(".chat-text > *")
                  .filter({ hasNot: page.locator(".chat-assistant-attachments") });
                await blocks.last().waitFor();
                const reference = await gap(blocks.nth(1), blocks.nth(2));
                expect(reference).toBeGreaterThan(0);
                const expectedBefore = reference * (name === "heading" ? 1.5 : 1);
                // Wide desktop tables reserve extra space after their compact toolbar/table block.
                const expectedAfter = name === "table" && width === 1440 ? 24 : reference;
                await expect
                  .poll(async () =>
                    Math.max(
                      Math.abs((await gap(card, blocks.first())) - expectedBefore),
                      Math.abs((await gap(blocks.first(), blocks.nth(1))) - expectedAfter),
                    ),
                  )
                  .toBeLessThanOrEqual(1);
              } catch (error) {
                void closeAfterFailure(error).catch(() => {});
                throw error;
              }
            },
            close: async () => {
              await failedClose;
            },
          });
        } finally {
          testContext.signal.removeEventListener("abort", onAbort);
        }
      },
    );
  }

  it("keeps user files outside the painted text and preserves column rhythm", async () => {
    const count = 5;
    await withChat(
      390,
      message(
        "user",
        referenceText,
        Array.from({ length: count }, (_, index) => attachment(index)),
      ),
    )(async (page) => {
      const cards = page.locator(".chat-assistant-attachment-card");
      const reference = await paragraphGap(page.locator(".chat-text > p"));
      await expect.poll(() => cards.count()).toBe(count);
      await expectBrowser(page.locator(".chat-group.user .chat-bubble")).toHaveCSS(
        "background-color",
        "rgba(0, 0, 0, 0)",
      );
      for (let index = 1; index < count; index += 1) {
        await expectGap(cards.nth(index - 1), cards.nth(index), reference);
      }
      await expectGap(cards.last(), page.locator(".chat-text"), reference);
      expect(
        await page
          .locator(".chat-thread")
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
    });
  });

  it.each([true, false])("aligns visible media with its participant (self=%s)", async (self) => {
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
              textBlock("Compare the screenshot, logs, and release notes."),
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
      const layout = await group.evaluate((node, own) => {
        const text = node.querySelector(".chat-text")!;
        const textRect = text.getBoundingClientRect();
        const edge = own ? "right" : "left";
        return {
          shellPaint: getComputedStyle(node.querySelector(".chat-bubble")!).backgroundColor,
          textPaint: getComputedStyle(text).backgroundColor,
          media: [
            ...node.querySelectorAll(".chat-message-image, .chat-assistant-attachment-card"),
          ].map((media) => {
            const rect = media.getBoundingClientRect();
            return {
              offset: Math.abs(rect[edge] - textRect[edge]),
              gap: textRect.top - rect.bottom,
            };
          }),
        };
      }, self);
      expect(layout.shellPaint).toBe("rgba(0, 0, 0, 0)");
      expect(layout.textPaint).not.toBe("rgba(0, 0, 0, 0)");
      expect(layout.media).toHaveLength(2);
      for (const { offset, gap: separation } of layout.media) {
        expect(offset).toBeLessThanOrEqual(1);
        expect(separation).toBeGreaterThan(0);
      }
    });
  });

  it("preserves nested user fences while sharing the top-level attachment rhythm", async () => {
    await withChat(
      390,
      message(
        "user",
        `\`\`\`txt\ntop level\n\`\`\`\n\n${referenceText}\n\n> Before code.\n>\n> \`\`\`txt\n> nested code\n> \`\`\`\n>\n> After code.`,
        [attachment()],
      ),
    )(async (page) => {
      const text = page.locator(".chat-text");
      const nestedCode = text.locator("blockquote pre");
      await nestedCode.waitFor();
      const reference = await paragraphGap(text.locator(":scope > p"));
      const card = page.locator(".chat-assistant-attachment-card");
      for (const [above, below] of [
        [card, text],
        [text.locator("blockquote > p").first(), nestedCode],
        [nestedCode, text.locator("blockquote > p").last()],
      ] as const) {
        await expectGap(above, below, reference);
      }
    });
  });

  it("shares the block rhythm inside expanded tool output", async () => {
    await withChat(390, message("user", referenceText), {
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
        textBlock("Generated output."),
      ],
    })(async (page) => {
      await page.locator(".chat-tool-msg-summary").first().click();
      const body = page.locator(".chat-tool-msg-body");
      const text = body.locator(":scope > .chat-text");
      await text.waitFor();
      const reference = await paragraphGap(page.locator(".chat-group.user .chat-text > p"));
      const attachments = body.locator(":scope > .chat-assistant-attachments");
      await expectGap(attachments, text, reference);
      await expectGap(body.locator(":scope > .chat-message-images"), attachments, reference);
    });
  });
});
