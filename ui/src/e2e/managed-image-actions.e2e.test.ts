import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { buildControlUiCspHeader } from "../../../src/gateway/control-ui-csp.ts";
import { finishElementAnimations } from "../test-helpers/animations.ts";
import { readControlUiE2eDownload } from "../test-helpers/control-ui-e2e-download.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
const controlUiBasePath = "/rosita";

suite.define(() => {
  it.each([0, 2])("reuses full image bytes after %i failed download attempts", async (failures) => {
    const filenamePrefix = "a".repeat(119);
    const imageTitle = `${filenamePrefix}📊`;
    const context = await suite.newBrowserContext({
      ...createControlUiE2eContextOptions(),
      viewport: failures === 0 ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      hasTouch: failures === 0,
      isMobile: failures === 0,
    });
    const page = await context.newPage();
    await page.clock.install();
    await page.route(`**${controlUiBasePath}/chat`, async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: {
          ...response.headers(),
          "content-security-policy": buildControlUiCspHeader(),
        },
      });
    });
    const attachmentId = crypto.randomUUID();
    const artifactId = `artifact_managed_image_${attachmentId}`;
    const imageUrl = `/api/chat/media/outgoing/agent%3Amain%3Amain/${attachmentId}/full`;
    const ticketedUrl = `${imageUrl}?mediaTicket=ticket-e2e`;
    const imageBytes = await readFile(
      path.join(process.cwd(), "docs/assets/openclaw-banner-dark.png"),
    );
    const requestedVariants: string[] = [];
    let remainingFailures = failures;
    await page.route(`**${controlUiBasePath}/api/chat/media/outgoing/**`, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      expect(url.pathname).toMatch(/^\/rosita\/api\/chat\/media\/outgoing\//u);
      expect(url.searchParams.get("mediaTicket")).toBe("ticket-e2e");
      expect(request.headers().authorization).toBeUndefined();
      expect(request.headers()["x-openclaw-requester-session-key"]).toBeUndefined();
      const variant = url.pathname.split("/").at(-1) ?? "";
      requestedVariants.push(variant);
      if (variant === "full" && remainingFailures > 0) {
        remainingFailures -= 1;
        await route.fulfill({ status: 503, body: "Temporarily unavailable" });
        return;
      }
      await route.fulfill({ body: imageBytes, contentType: "image/png" });
    });
    const gateway = await installMockGateway(page, {
      basePath: controlUiBasePath,
      historyMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "image",
              artifactId,
              url: imageUrl,
              alt: imageTitle,
              mimeType: "image/png",
              width: 1280,
              height: 358,
            },
          ],
          timestamp: Date.now(),
        },
      ],
      methodResponses: {
        "artifacts.download": {
          artifact: {
            id: artifactId,
            type: "image",
            title: imageTitle,
            mimeType: "image/png",
            download: { mode: "url" },
          },
          url: ticketedUrl,
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}${controlUiBasePath.slice(1)}/chat`);
      const image = page.getByAltText(imageTitle);
      await image.waitFor({ state: "visible", timeout: 10_000 });
      await expect
        .poll(() =>
          image.evaluate((element) =>
            element instanceof HTMLImageElement && element.complete ? element.naturalWidth : 0,
          ),
        )
        .toBe(1280);
      expect(requestedVariants).toEqual(["thumbnail"]);

      const imageFrame = page.locator(".chat-image-frame--managed").filter({ has: image });
      const imageActions = imageFrame.locator(".chat-image-actions");
      const openImage = page.getByRole("button", { name: `Open image ${imageTitle}` });
      let downloadButton;
      if (failures === 0) {
        expect(await imageActions.isVisible()).toBe(false);
        await openImage.tap();
        const lightbox = page.getByRole("dialog", { name: `Image preview: ${imageTitle}` });
        await lightbox.waitFor({ state: "visible" });
        downloadButton = lightbox.getByRole("button", { name: "Download image", exact: true });
        await downloadButton.waitFor({ state: "visible" });
      } else {
        await page.mouse.move(0, 0);
        expect(await imageActions.evaluate((element) => getComputedStyle(element).opacity)).toBe(
          "0",
        );
        await imageFrame.hover();
        expect(await imageActions.evaluate((element) => getComputedStyle(element).opacity)).toBe(
          "1",
        );
        downloadButton = imageActions.getByRole("button", { name: "Download image" });
        const imageBox = await image.boundingBox();
        const actionsBox = await imageActions.boundingBox();
        expect(actionsBox!.x).toBeGreaterThanOrEqual(imageBox!.x);
        expect(actionsBox!.x + actionsBox!.width).toBeLessThanOrEqual(
          imageBox!.x + imageBox!.width,
        );
        expect(actionsBox!.y + actionsBox!.height).toBeLessThanOrEqual(
          imageBox!.y + imageBox!.height,
        );
        await page.mouse.move(0, 0);
        await downloadButton.focus();
        expect(await imageActions.evaluate((element) => getComputedStyle(element).opacity)).toBe(
          "1",
        );
        await page.keyboard.press("Tab");
        expect(
          await imageActions
            .getByRole("button", { name: "Copy image" })
            .evaluate((button) => button === document.activeElement),
        ).toBe(true);
      }
      for (let attempt = 0; attempt < failures; attempt += 1) {
        await downloadButton.click();
        const error = page.getByText("Could not download this image. Try again.", {
          exact: true,
        });
        await error.waitFor({ state: "visible" });
        await page.clock.runFor(6_000);
        await error.waitFor({ state: "hidden" });
        expect(requestedVariants.filter((variant) => variant === "full")).toHaveLength(attempt + 1);
      }
      const downloadImage = async () => {
        const download = page.waitForEvent("download");
        await downloadButton.click();
        return download;
      };
      expect((await downloadImage()).suggestedFilename()).toBe(`${filenamePrefix}.png`);
      expect(await readControlUiE2eDownload(await downloadImage())).toEqual(imageBytes);

      if (failures > 0) {
        await openImage.click();
      }
      await page
        .getByRole("dialog", { name: `Image preview: ${imageTitle}` })
        .waitFor({ state: "visible" });
      await page
        .locator("openclaw-image-lightbox openclaw-modal-dialog > dialog")
        .evaluate(finishElementAnimations);
      const viewer = await page.locator("openclaw-image-lightbox .lightbox").boundingBox();
      expect(viewer).toMatchObject({ x: 0, y: 0, ...page.viewportSize() });
      // Mobile opens the viewer before downloading, so it first loads a larger preview.
      const previews = failures === 0 ? ["thumbnail", "thumbnail"] : ["thumbnail"];
      expect(requestedVariants).toEqual([...previews, ...Array(failures + 1).fill("full")]);
      expect(await gateway.getRequests("artifacts.download")).toHaveLength(
        previews.length + failures + 1,
      );
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
