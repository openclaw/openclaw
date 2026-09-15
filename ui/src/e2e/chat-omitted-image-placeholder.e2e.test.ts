import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Omitted history image placeholder" });
const RETAINED_IMAGE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAmElEQVR4nO3QMREAIBDAsHeERQyjAWRkoEP2Xmftc382OkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAO0B06OyaOxP7RwAAAAASUVORK5CYII=";

suite.define(() => {
  it("keeps sanitized historical images visible without fake recovery actions", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      await installMockGateway(page, {
        historyMessages: [
          {
            role: "user",
            content: [{ type: "image", omitted: true, bytes: 12 * 1024 }],
            timestamp: 1,
          },
        ],
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      const placeholder = page.locator(".chat-assistant-attachment-card", {
        hasText: "Omitted from history",
      });
      await placeholder.waitFor({ state: "visible" });

      expect(await placeholder.textContent()).toContain("Image");
      expect(await placeholder.textContent()).toContain("History");
      expect(await placeholder.textContent()).toContain("12 KB");
      expect(await placeholder.locator("a, button, img, audio, video").count()).toBe(0);
    });
  });

  it("renders a retained image URL without an omitted-media placeholder", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      await installMockGateway(page, {
        historyMessages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                omitted: true,
                bytes: 12 * 1024,
                url: RETAINED_IMAGE_DATA_URL,
              },
            ],
            timestamp: 1,
          },
        ],
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      await page
        .locator(`img.chat-message-image[src="${RETAINED_IMAGE_DATA_URL}"]`)
        .waitFor({ state: "visible" });
      expect(
        await page
          .locator(".chat-assistant-attachment-card", { hasText: "Omitted from history" })
          .count(),
      ).toBe(0);
    });
  });

  it("recovers a legacy inline history image only when it enters the visible transcript", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const artifactId = "artifact_history_image_e2e";
      const gateway = await installMockGateway(page, {
        historyMessages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                omitted: true,
                bytes: 68,
                mimeType: "image/png",
                alt: "Recovered history image",
                artifactId,
                url: `/api/chat/media/outgoing/__history__/${artifactId}/full`,
              },
            ],
            timestamp: 1,
          },
        ],
        methodResponses: {
          "artifacts.download": {
            artifact: {
              id: artifactId,
              type: "image",
              title: "Recovered history image",
              mimeType: "image/png",
              download: { mode: "bytes" },
            },
            encoding: "base64",
            data: RETAINED_IMAGE_DATA_URL.slice(RETAINED_IMAGE_DATA_URL.indexOf(",") + 1),
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      const image = page.getByAltText("Recovered history image");
      await image.waitFor({ state: "visible" });
      await expect
        .poll(() =>
          image.evaluate((element) =>
            element instanceof HTMLImageElement && element.complete ? element.naturalWidth : 0,
          ),
        )
        .toBe(64);
      expect(
        await page
          .locator(".chat-assistant-attachment-card", { hasText: "Omitted from history" })
          .count(),
      ).toBe(0);
      const request = await gateway.waitForRequest("artifacts.download");
      expect(request.params).toMatchObject({
        sessionKey: "agent:main:main",
        artifactId,
      });
    });
  });
});
