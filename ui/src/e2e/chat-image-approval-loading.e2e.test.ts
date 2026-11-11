import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { mediaTicketPayload } from "../test-helpers/control-ui-attachment-fixtures.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI image approval and loading",
  startServerBeforeBrowser: true,
});
const frameSizes = (frames: Locator) =>
  frames.evaluateAll((elements) =>
    elements.map((element) => {
      const { width, height } = element.getBoundingClientRect();
      return { width, height };
    }),
  );

suite.define(() => {
  it.each([
    { width: 1440, colorScheme: "dark" },
    { width: 390, colorScheme: "light" },
  ] as const)("loading vs approval: $width/$colorScheme", async ({ width, colorScheme }) => {
    const metadata = createDeferred();
    const imageBytes = createDeferred();
    const approval = createDeferred();
    await suite.withPage(
      { viewport: { width, height: 900 }, colorScheme },
      async ({ page }) => {
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
          if (!meta) {
            await imageBytes.promise;
            return route.fulfill({
              contentType: "image/svg+xml",
              body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#b8cecd"/></svg>',
            });
          }
          if (source === protectedSource && method !== "POST") {
            return route.fulfill({
              json: {
                available: false,
                code: "outside-allowed-folders",
                retryable: false,
                canAllow: true,
              },
            });
          }
          if (source === protectedSource) {
            expect(url.searchParams.get("allow")).toBe("1");
          }
          await (source === protectedSource ? approval : metadata).promise;
          await route.fulfill({
            json: mediaTicketPayload("image-proof-ticket", 300_000),
          });
        });
        await installMockGateway(page, {
          historyMessages: (
            [
              ["user", "loading-gallery", normalSources],
              ["assistant", "approval-image", [protectedSource]],
            ] as const
          ).map(([role, id, sources], index) => ({
            role,
            content: [
              { type: "text", text: "Images to compare." },
              ...sources.map((url) => ({
                type: "image",
                url,
                ...(url === protectedSource ? { alt: "Needs approval" } : {}),
                width: 1200,
                height: 800,
              })),
            ],
            timestamp: index + 1,
            __openclaw: { id, seq: index + 1 },
          })),
        });
        await page.goto(suite.server.baseUrl + "chat");
        const gallery = page.locator(".chat-group.user .chat-message-images");
        const frames = gallery.locator(".chat-image-frame");
        const allow = page.getByRole("button", { name: "Allow image", exact: true });
        await allow.waitFor({ state: "visible" });
        await expect.poll(() => frames.count()).toBe(2);
        await waitForChatScrollIdle(page);
        const blocked = page.locator(".chat-image-frame--compact").filter({ has: allow });
        const reason = blocked.locator(".chat-assistant-attachment-card__status-reason");
        expect((await reason.textContent())?.trim()).not.toBe("");
        expect(
          await reason.evaluate((element) => ({
            wrapped: getComputedStyle(element).whiteSpace === "normal",
            clipped:
              element.scrollHeight > element.clientHeight + 1 ||
              element.scrollWidth > element.clientWidth + 1,
          })),
        ).toEqual({ wrapped: true, clipped: false });
        const actionBounds = await allow.boundingBox();
        expect(actionBounds?.width).toBeGreaterThanOrEqual(44);
        expect(actionBounds?.height).toBeGreaterThanOrEqual(44);
        const cardBounds = await blocked.boundingBox();
        expect(cardBounds!.height).toBeGreaterThan(actionBounds!.height);
        expect(actionBounds!.y + actionBounds!.height).toBeLessThanOrEqual(
          cardBounds!.y + cardBounds!.height,
        );
        expect(
          requests.some((request) => request.source === protectedSource && !request.meta),
        ).toBe(false);
        const before = await frameSizes(frames);
        for (const frame of await frames.all()) {
          const skeleton = frame.locator(".chat-image-skeleton");
          await skeleton.waitFor({ state: "visible" });
          expect(
            await Promise.all([
              frame.textContent().then((text) => text?.trim()),
              frame.locator(".chat-assistant-attachment-card").count(),
              skeleton.evaluate((element) => getComputedStyle(element, "::after").animationName),
            ]),
          ).toEqual(["", 0, "shimmer"]);
        }
        metadata.resolve();
        await expect.poll(() => gallery.locator("img").count()).toBe(2);
        expect(
          await gallery
            .locator("img")
            .evaluateAll((images: HTMLImageElement[]) =>
              images.every((image) => image.naturalWidth === 0),
            ),
        ).toBe(true);
        expect(await allow.isVisible()).toBe(true);
        imageBytes.resolve();
        await gallery
          .locator("img")
          .evaluateAll((images: HTMLImageElement[]) =>
            Promise.all(images.map((image) => image.decode())),
          );
        expect(await frameSizes(frames)).toEqual(before);
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
      },
      async () => {
        metadata.resolve();
        imageBytes.resolve();
        approval.resolve();
      },
    );
  });
});
