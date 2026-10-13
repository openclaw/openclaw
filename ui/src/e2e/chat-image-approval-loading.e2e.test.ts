import path from "node:path";
import { expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI image approval and loading",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it.each([
    { width: 1440, colorScheme: "dark" },
    { width: 390, colorScheme: "light" },
  ] as const)(
    "distinguishes pending image reads from approval at $width px ($colorScheme)",
    async ({ width, colorScheme }) => {
      await suite.withPage({ viewport: { width, height: 900 }, colorScheme }, async ({ page }) => {
        const metadata = createDeferred();
        const imageBytes = createDeferred();
        const approval = createDeferred();
        const normalSources = [
          "media://inbound/loading-one.png",
          "media://inbound/loading-two.png",
        ];
        const protectedSource = "/outside/needs-approval.png";
        const requests: { source: string; meta: boolean; method: string }[] = [];
        await page.route("**/__openclaw__/assistant-media?**", async (route) => {
          const url = new URL(route.request().url());
          const source = url.searchParams.get("source") ?? "";
          const meta = url.searchParams.get("meta") === "1";
          const method = route.request().method();
          requests.push({ source, meta, method });
          if (meta) {
            if (source === protectedSource && method !== "POST") {
              await route.fulfill({
                json: {
                  available: false,
                  code: "outside-allowed-folders",
                  retryable: false,
                  canAllow: true,
                },
              });
              return;
            }
            if (source === protectedSource) {
              expect(url.searchParams.get("allow")).toBe("1");
              await approval.promise;
            } else {
              await metadata.promise;
            }
            await route.fulfill({
              json: {
                available: true,
                mediaTicket: "image-proof-ticket",
                mediaTicketExpiresAt: new Date(Date.now() + 300_000).toISOString(),
              },
            });
            return;
          }
          await imageBytes.promise;
          await route.fulfill({
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#b8cecd"/></svg>',
          });
        });
        try {
          await installMockGateway(page, {
            historyMessages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "Compare these two images." },
                  ...normalSources.map((url) => ({ type: "image", url, width: 1200, height: 800 })),
                ],
                timestamp: 1,
                __openclaw: { id: "loading-gallery", seq: 1 },
              },
              {
                role: "assistant",
                content: [
                  { type: "text", text: "This separate image needs your permission." },
                  {
                    type: "image",
                    url: protectedSource,
                    alt: "Needs approval",
                    width: 1200,
                    height: 800,
                  },
                ],
                timestamp: 2,
                __openclaw: { id: "approval-image", seq: 2 },
              },
            ],
          });
          await page.goto(suite.server.baseUrl + "chat");
          const gallery = page.locator(".chat-group.user .chat-message-images");
          const frames = gallery.locator(".chat-image-frame");
          const allow = page.getByRole("button", { name: "Allow image", exact: true });
          await allow.waitFor({ state: "visible" });
          await expect.poll(() => frames.count()).toBe(2);
          await waitForChatScrollIdle(page);
          await page.locator(".chat-group.user").screenshot({
            path: path.join(suite.artifactDir, "loading-" + width + "-" + colorScheme + ".png"),
            animations: "disabled",
          });
          const blocked = page.locator(".chat-image-frame--compact").filter({ has: allow });
          expect((await blocked.boundingBox())?.height).toBe(74);
          expect(
            requests.some((request) => request.source === protectedSource && !request.meta),
          ).toBe(false);
          const before = await frames.evaluateAll((elements) =>
            elements.map((element) => {
              const rect = element.getBoundingClientRect();
              return { width: rect.width, height: rect.height };
            }),
          );
          for (const frame of await frames.all()) {
            expect((await frame.textContent())?.trim()).toBe("");
            expect(await frame.locator(".chat-assistant-attachment-card").count()).toBe(0);
            const skeleton = frame.locator(".chat-image-skeleton");
            await skeleton.waitFor({ state: "visible" });
            expect(
              await skeleton.evaluate(
                (element) => getComputedStyle(element, "::after").animationName,
              ),
            ).toBe("shimmer");
          }
          metadata.resolve();
          await expect.poll(() => gallery.locator("img").count()).toBe(2);
          expect(
            await gallery.evaluate((element) =>
              Array.from(element.querySelectorAll("img")).every(
                (image) => image.naturalWidth === 0,
              ),
            ),
          ).toBe(true);
          expect(await allow.isVisible()).toBe(true);
          imageBytes.resolve();
          await gallery.evaluate((element) =>
            Promise.all(Array.from(element.querySelectorAll("img"), (image) => image.decode())),
          );
          expect(
            await frames.evaluateAll((elements) =>
              elements.map((element) => {
                const rect = element.getBoundingClientRect();
                return { width: rect.width, height: rect.height };
              }),
            ),
          ).toEqual(before);
          expect(await gallery.locator(".chat-image-skeleton").count()).toBe(0);
          expect(await allow.isVisible()).toBe(true);
          await allow.click();
          await expect
            .poll(() => requests.filter((request) => request.method === "POST").length)
            .toBe(1);
          const approving = page.locator(
            '.chat-bubble[data-entry-id="approval-image"] .chat-image-frame',
          );
          expect((await approving.textContent())?.trim()).toBe("");
          expect(await approving.locator(".chat-image-skeleton").count()).toBe(1);
          approval.resolve();
          const approvedImage = approving.locator("img");
          await approvedImage.waitFor({ state: "visible" });
          await approvedImage.evaluate((image) => (image as HTMLImageElement).decode());
          expect(await allow.count()).toBe(0);
          expect(
            requests.filter((request) => request.meta && normalSources.includes(request.source)),
          ).toHaveLength(2);
        } finally {
          metadata.resolve();
          imageBytes.resolve();
          approval.resolve();
        }
      });
    },
  );
});
