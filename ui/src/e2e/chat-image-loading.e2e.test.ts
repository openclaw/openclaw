import { expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { newChatPage, waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI image loading",
  startServerBeforeBrowser: true,
  trackBrowserContexts: true,
});

function imageLayout(element: Element) {
  const row = element.closest<HTMLElement>(".chat-virtual-row")!;
  const next = row
    .closest(".chat-thread")!
    .querySelector('.chat-bubble[data-entry-id="image-message-3"]')!
    .closest<HTMLElement>(".chat-virtual-row")!;
  const bounds = element.getBoundingClientRect();
  const rowBounds = row.getBoundingClientRect();
  const nextTop = next.getBoundingClientRect().top;
  return {
    geometry: {
      height: row.offsetHeight,
      top: rowBounds.top,
      nextTop,
      imageWidth: bounds.width,
      imageHeight: bounds.height,
    },
    gap: nextTop - rowBounds.bottom,
  };
}

suite.define(() => {
  it.each([true, false])(
    "keeps saved images stable through metadata and decode (dimensions: %s)",
    async (sized) => {
      const page = await newChatPage(suite, {
        reducedMotion: "reduce",
        viewport: { width: 1440, height: 900 },
      });
      const imageUrl = "media://inbound/sizing-image.png";
      const metadataReady = createDeferred();
      const metadataRequested = createDeferred();
      const imageData = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 480;
        canvas.height = 240;
        canvas.getContext("2d")!.fillRect(0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/png").split(",")[1]!;
      });
      const imageReady = createDeferred();
      await page.route("**/__openclaw__/assistant-media?**", async (route) => {
        if (new URL(route.request().url()).searchParams.get("meta") === "1") {
          metadataRequested.resolve();
          await metadataReady.promise;
          await route.fulfill({
            json: {
              available: true,
              mediaTicket: "sizing-ticket",
              mediaTicketExpiresAt: new Date(Date.now() + 300_000).toISOString(),
            },
          });
          return;
        }
        await imageReady.promise;
        await route.fulfill({
          contentType: "image/png",
          body: Buffer.from(imageData, "base64"),
        });
      });
      await installMockGateway(page, {
        historyMessages: Array.from({ length: 60 }, (_, i) => ({
          role: i % 2 ? "assistant" : "user",
          content: i === 2 ? "Delayed image." : `Image fixture message ${i}.`,
          timestamp: i + 1,
          __openclaw: {
            id: `image-message-${i}`,
            seq: i + 1,
            ...(i === 2
              ? {
                  media: [
                    {
                      url: imageUrl,
                      kind: "image",
                      contentType: "image/png",
                      fileName: "Intrinsic size proof",
                      ...(sized ? { width: 480, height: 240 } : {}),
                    },
                  ],
                  mediaImageLayout: { slots: [{ kind: "inline", factIndex: 0 }] },
                }
              : {}),
          },
        })),
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
      await page.getByText("Image fixture message 59.", { exact: false }).waitFor();
      await thread.hover();
      await page.mouse.wheel(0, -100_000);
      const image = thread.getByRole("img", { name: "Intrinsic size proof" });
      const frame = thread.locator(
        '.chat-bubble[data-entry-id="image-message-2"] .chat-image-frame',
      );
      await frame.waitFor({ state: "visible" });
      await metadataRequested.promise;
      const geometry = async () => (await frame.evaluate(imageLayout)).geometry;
      const gap = async () => (await image.evaluate(imageLayout)).gap;
      const naturalHeight = () =>
        image.evaluate((element) => (element as HTMLImageElement).naturalHeight);
      await waitForChatScrollIdle(page);
      const before = await geometry();
      expect(before.imageWidth).toBeGreaterThan(0);
      expect(before.imageHeight).toBeCloseTo(sized ? 200 : 400 / 1.5, 1);
      expect(await image.count()).toBe(0);
      metadataReady.resolve();
      await image.waitFor({ state: "attached" });
      await waitForChatScrollIdle(page);
      expect(await geometry()).toEqual(before);
      expect(await naturalHeight()).toBe(0);
      imageReady.resolve();
      await image.evaluate((element) => (element as HTMLImageElement).decode());
      expect(await naturalHeight()).toBe(240);
      await waitForChatScrollIdle(page);
      expect(await geometry()).toEqual(before);
      expect(Math.abs(await gap())).toBeLessThanOrEqual(1);
    },
  );
  it.each([
    { colorScheme: "light", reducedMotion: "no-preference" },
    { colorScheme: "dark", reducedMotion: "no-preference" },
    { colorScheme: "dark", reducedMotion: "reduce" },
  ] as const)(
    "renders the image shimmer with $colorScheme and $reducedMotion",
    async ({ colorScheme, reducedMotion }) => {
      const page = await newChatPage(suite, {
        colorScheme,
        reducedMotion,
        viewport: { width: 1280, height: 900 },
      });
      const ready = createDeferred();
      const source = "/api/chat/media/outgoing/agent%3Amain%3Amain/shimmer-proof/full";
      await page.route("**/api/chat/media/outgoing/**", async (route) => {
        await ready.promise;
        await route.fulfill({
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#57908b"/></svg>',
        });
      });
      try {
        await installMockGateway(page, {
          historyMessages: [{ role: "assistant", content: [{ type: "image", url: source }] }],
        });
        await page.goto(suite.server.baseUrl + "chat");
        const frame = page.locator(".chat-image-frame");
        const skeleton = frame.locator(".chat-image-skeleton");
        await skeleton.waitFor({ state: "visible" });
        await waitForChatScrollIdle(page);
        const motion = await skeleton.evaluate((element) => {
          const style = getComputedStyle(element, "::after");
          return {
            name: style.animationName,
            duration: Number.parseFloat(style.animationDuration),
            iterations: style.animationIterationCount,
            running: element
              .getAnimations({ subtree: true })
              .some((animation) => animation.playState === "running"),
            transform: style.transform,
            width: element.clientWidth,
          };
        });
        if (reducedMotion === "reduce") {
          expect(motion).toMatchObject({ name: "none", iterations: "1", running: false });
          expect(motion.duration).toBeLessThan(0.001);
          const highlightX = Number.parseFloat(motion.transform.split(",")[4] ?? "NaN");
          expect(Math.abs(highlightX + motion.width)).toBeLessThanOrEqual(1);
        } else {
          expect(motion).toMatchObject({ name: "shimmer", duration: 2.4, iterations: "infinite" });
        }
      } finally {
        ready.resolve();
      }
    },
  );
});
