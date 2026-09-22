import { expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI image loading",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("keeps delayed images and adjacent rows stable through a transcript remount", async () => {
    await suite.withPage(
      { reducedMotion: "reduce", viewport: { width: 1440, height: 900 } },
      async ({ page }) => {
        const imageUrl = `${suite.server.baseUrl}sizing-image.png`;
        const imageData = await page.evaluate(() => {
          const canvas = document.createElement("canvas");
          canvas.width = 480;
          canvas.height = 240;
          canvas.getContext("2d")!.fillRect(0, 0, canvas.width, canvas.height);
          return canvas.toDataURL("image/png").split(",")[1]!;
        });
        let releaseImage!: () => void;
        const imageReady = new Promise<void>((resolve) => {
          releaseImage = resolve;
        });
        await page.route(imageUrl, async (route) => {
          await imageReady;
          await route.fulfill({ contentType: "image/png", body: Buffer.from(imageData, "base64") });
        });
        await installMockGateway(page, {
          historyMessages: Array.from({ length: 60 }, (_, index) => ({
            role: index % 2 ? "assistant" : "user",
            content:
              index === 1
                ? [
                    { type: "text", text: "Delayed image." },
                    { type: "image", url: imageUrl, alt: "Intrinsic size proof" },
                  ]
                : `Image fixture message ${index}.`,
            timestamp: index + 1,
            __openclaw: { id: `image-message-${index}`, seq: index + 1 },
          })),
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
        await page.getByText("Image fixture message 59.", { exact: false }).waitFor();
        await thread.hover();
        await page.mouse.wheel(0, -100_000);
        const image = thread.getByRole("img", { name: "Intrinsic size proof" });
        await image.waitFor({ state: "attached" });
        const geometry = () =>
          image.evaluate((element) => {
            const row = element.closest<HTMLElement>(".chat-virtual-row")!;
            const next = row
              .closest(".chat-thread")!
              .querySelector('.chat-bubble[data-entry-id="image-message-2"]')!
              .closest<HTMLElement>(".chat-virtual-row")!;
            const frame = element.closest(".chat-image-frame")!.getBoundingClientRect();
            return {
              height: row.offsetHeight,
              top: row.getBoundingClientRect().top,
              nextTop: next.getBoundingClientRect().top,
              imageWidth: frame.width,
              imageHeight: frame.height,
            };
          });
        await waitForChatScrollIdle(page);
        const before = await geometry();
        expect(before.imageWidth).toBeGreaterThan(0);
        expect(before.imageHeight).toBeGreaterThan(0);
        expect(await image.evaluate((element) => (element as HTMLImageElement).naturalHeight)).toBe(
          0,
        );
        releaseImage();
        await image.evaluate((element) => (element as HTMLImageElement).decode());
        expect(await image.evaluate((element) => (element as HTMLImageElement).naturalHeight)).toBe(
          240,
        );
        await waitForChatScrollIdle(page);
        expect(await geometry()).toEqual(before);
        const gap = () =>
          image.evaluate((element) => {
            const row = element.closest<HTMLElement>(".chat-virtual-row")!;
            const next = row
              .closest(".chat-thread")!
              .querySelector('.chat-bubble[data-entry-id="image-message-2"]')!
              .closest<HTMLElement>(".chat-virtual-row")!;
            return next.getBoundingClientRect().top - row.getBoundingClientRect().bottom;
          });
        expect(Math.abs(await gap())).toBeLessThanOrEqual(1);
        await page.locator(".chat-scroll-to-bottom").click();
        await expect.poll(() => image.count()).toBe(0);
        await expect
          .poll(() =>
            thread.evaluate((element) =>
              Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop),
            ),
          )
          .toBeLessThanOrEqual(2);
        await thread.hover();
        await page.mouse.wheel(0, -100_000);
        await image.waitFor({ state: "visible" });
        await expect.poll(async () => (await geometry()).height).toBe(before.height);
        await image.evaluate((element) => (element as HTMLImageElement).decode());
        const returned = await geometry();
        expect(returned.imageWidth).toBe(before.imageWidth);
        expect(returned.imageHeight).toBe(before.imageHeight);
        expect(Math.abs(await gap())).toBeLessThanOrEqual(1);
      },
    );
  });
  it.each([
    { colorScheme: "light", reducedMotion: "no-preference" },
    { colorScheme: "dark", reducedMotion: "no-preference" },
    { colorScheme: "dark", reducedMotion: "reduce" },
  ] as const)(
    "keeps the themed shimmer and cached image stable ($colorScheme, $reducedMotion)",
    async ({ colorScheme, reducedMotion }) => {
      await suite.withPage(
        { colorScheme, reducedMotion, viewport: { width: 1280, height: 900 } },
        async ({ page }) => {
          const ready = createDeferred();
          let imageRequests = 0;
          const source = "/api/chat/media/outgoing/agent%3Amain%3Amain/shimmer-proof/full";
          await page.route("**/api/chat/media/outgoing/**", async (route) => {
            imageRequests += 1;
            await ready.promise;
            await route.fulfill({
              contentType: "image/svg+xml",
              body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#57908b"/></svg>',
            });
          });
          try {
            await installMockGateway(page, {
              historyMessages: Array.from({ length: 60 }, (_, index) => ({
                role: index % 2 ? "assistant" : "user",
                content:
                  index === 57
                    ? [
                        {
                          type: "image",
                          url: source,
                          alt: "Shimmer proof",
                          width: 1200,
                          height: 800,
                        },
                      ]
                    : "Image conversation message " + index + ".",
                timestamp: index + 1,
                __openclaw: { id: "shimmer-message-" + index, seq: index + 1 },
              })),
            });
            await page.goto(suite.server.baseUrl + "chat");
            const frame = page.locator(
              '.chat-bubble[data-entry-id="shimmer-message-57"] .chat-image-frame',
            );
            const skeleton = frame.locator(".chat-image-skeleton");
            await skeleton.waitFor({ state: "visible" });
            await waitForChatScrollIdle(page);
            const before = await frame.boundingBox();
            expect(before?.width).toBe(400);
            expect(before?.height).toBeCloseTo(400 / 1.5, 1);
            expect(await frame.textContent()).toBe("");
            expect(await frame.locator("svg").count()).toBe(0);
            const motion = await skeleton.evaluate((element) => {
              const style = getComputedStyle(element, "::after");
              return {
                name: style.animationName,
                duration: Number.parseFloat(style.animationDuration),
                iterations: style.animationIterationCount,
              };
            });
            expect(motion.name).toBe("shimmer");
            if (reducedMotion === "reduce") {
              expect(motion.duration).toBeLessThan(0.001);
              expect(motion.iterations).toBe("1");
            } else {
              expect(motion.duration).toBe(2.4);
              expect(motion.iterations).toBe("infinite");
            }
            ready.resolve();
            const image = frame.locator("img");
            await image.waitFor({ state: "visible" });
            await image.evaluate((element) => (element as HTMLImageElement).decode());
            await waitForChatScrollIdle(page);
            expect(await frame.boundingBox()).toEqual(before);
            expect(await skeleton.count()).toBe(0);
            const loadedSource = await image.getAttribute("src");
            const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
            await thread.hover();
            await page.mouse.wheel(0, -100_000);
            await expect.poll(() => frame.count()).toBe(0);
            await page.locator(".chat-scroll-to-bottom").click();
            await image.waitFor({ state: "visible" });
            expect(await image.getAttribute("src")).toBe(loadedSource);
            expect(await skeleton.count()).toBe(0);
            await image.evaluate((element) => (element as HTMLImageElement).decode());
            expect(imageRequests).toBe(1);
          } finally {
            ready.resolve();
          }
        },
      );
    },
  );
});
