import type { Request } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI YouTube embeds" });

suite.define(() => {
  it("loads the provider player only after Play and keeps external playback available", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
      async ({ page, context }) => {
        const playerRequests: Request[] = [];
        const thumbnailRequests: Request[] = [];
        await context.route("https://i.ytimg.com/vi/**", async (route) => {
          thumbnailRequests.push(route.request());
          const missing = route.request().url().includes("/JkLmNoPqR_2/");
          await route.fulfill({
            status: missing ? 404 : 200,
            contentType: "image/svg+xml",
            body: missing
              ? "Not found"
              : '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><rect width="480" height="360" fill="teal"/></svg>',
          });
        });
        // This fixture proves the browser's request and frame lifecycle, not YouTube playback.
        await context.route("https://www.youtube-nocookie.com/embed/**", async (route) => {
          playerRequests.push(route.request());
          await route.fulfill({
            contentType: "text/html",
            body: "<!doctype html><title>Player transport fixture</title><p>Player fixture loaded</p>",
          });
        });
        await context.route("https://www.youtube.com/watch?**", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: "<!doctype html><title>External watch fixture</title><p>External video page</p>",
          }),
        );
        await installMockGateway(page, {
          historyMessages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: '[embed url="https://youtu.be/AbCdEfGhI_1?t=1m30s" title="Synthetic trailer" /]\n\n[embed url="https://youtu.be/JkLmNoPqR_2" title="Missing cover" /]',
                },
              ],
              timestamp: 100,
            },
          ],
        });
        // The standard mock bootstrap disables generic external embed URLs.
        await page.goto(`${suite.server.baseUrl}chat`);
        const card = page
          .locator("openclaw-youtube-video")
          .filter({ hasText: "Synthetic trailer" });
        const play = card.getByRole("button", { name: "Play Synthetic trailer", exact: true });
        await play.waitFor();
        await expect
          .poll(() => card.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth))
          .toBe(480);
        expect(playerRequests).toHaveLength(0);
        expect(await card.locator("iframe").count()).toBe(0);
        expect(thumbnailRequests[0]?.headers().referer).toBeUndefined();
        const watch = card.getByRole("link", { name: "Open on YouTube", exact: true });
        expect(await watch.getAttribute("href")).toBe(
          "https://www.youtube.com/watch?v=AbCdEfGhI_1&t=90",
        );

        await play.click();
        const frame = card.locator("iframe");
        await frame.contentFrame().getByText("Player fixture loaded", { exact: true }).waitFor();
        expect(playerRequests).toHaveLength(1);
        const requested = new URL(playerRequests[0]!.url());
        expect(requested.origin).toBe("https://www.youtube-nocookie.com");
        expect(requested.pathname).toBe("/embed/AbCdEfGhI_1");
        expect(Object.fromEntries(requested.searchParams)).toEqual({
          autoplay: "1",
          playsinline: "1",
          start: "90",
        });
        expect(playerRequests[0]!.headers().referer).toBe(
          `${new URL(suite.server.baseUrl).origin}/`,
        );
        expect(playerRequests[0]!.headers().authorization).toBeUndefined();
        expect(await watch.isVisible()).toBe(true);

        const missing = page.locator("openclaw-youtube-video").filter({ hasText: "Missing cover" });
        const missingPlay = missing.getByRole("button", {
          name: "Play Missing cover",
          exact: true,
        });
        await missingPlay.click();
        await missing.locator("iframe").contentFrame().getByText("Player fixture loaded").waitFor();
        expect(await card.locator("iframe").count()).toBe(0);
        await play.click();
        await frame.contentFrame().getByText("Player fixture loaded", { exact: true }).waitFor();
        expect(await missing.locator("iframe").count()).toBe(0);

        const loadedFrame = await frame.elementHandle();
        await card.getByRole("button", { name: "Close player", exact: true }).click();
        await play.waitFor();
        expect(await loadedFrame!.evaluate((element) => element.isConnected)).toBe(false);
        expect(await card.locator("iframe").count()).toBe(0);
        expect(
          await play.evaluate((button) => {
            const root = button.getRootNode();
            return root instanceof ShadowRoot && root.activeElement === button;
          }),
        ).toBe(true);

        await play.click();
        await frame.contentFrame().getByText("Player fixture loaded", { exact: true }).waitFor();
        await card.evaluate((element: HTMLElement) => {
          element.style.width = "190px";
        });
        const narrowPreview = card.getByRole("link", {
          name: "Open Synthetic trailer on YouTube",
          exact: true,
        });
        await narrowPreview.waitFor();
        const cardBounds = await card.boundingBox();
        const previewBounds = await narrowPreview.boundingBox();
        expect(previewBounds!.x + previewBounds!.width).toBeLessThanOrEqual(
          cardBounds!.x + cardBounds!.width,
        );
        expect(await card.locator("iframe").count()).toBe(0);
        const [external] = await Promise.all([context.waitForEvent("page"), watch.click()]);
        await external.getByText("External video page", { exact: true }).waitFor();
        expect(external.url()).toBe("https://www.youtube.com/watch?v=AbCdEfGhI_1&t=90");
        await external.close();

        await missing
          .getByRole("button", { name: "Play Missing cover", exact: true })
          .scrollIntoViewIfNeeded();
        await expect.poll(() => missing.locator("img").count()).toBe(0);
        expect(
          await missing
            .getByRole("link", { name: "Open on YouTube", exact: true })
            .getAttribute("href"),
        ).toBe("https://www.youtube.com/watch?v=JkLmNoPqR_2");
        expect(
          await missing
            .getByRole("button", { name: "Play Missing cover", exact: true })
            .isVisible(),
        ).toBe(true);
      },
    );
  });
});
