import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Composer attachment containment" });

suite.define(() => {
  it.each(
    ["new", "chat"].flatMap((route) =>
      [
        { width: 390, height: 844 },
        { width: 1050, height: 764 },
        { width: 844, height: 390 },
      ].map(({ width, height }) => ({ route, width, height })),
    ),
  )(
    "keeps the $route attachment rail inside its surface at $width×$height",
    async ({ route, width, height }) => {
      await suite.withPage({ viewport: { width, height }, hasTouch: true }, async ({ page }) => {
        await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}${route}`);
        const composer = page.locator(".agent-chat__input");
        await composer.waitFor();
        await composer.locator("textarea").fill("Compare the attached images.");
        const png = await page.evaluate(() => {
          const canvas = document.createElement("canvas");
          canvas.width = 96;
          canvas.height = 96;
          const context = canvas.getContext("2d")!;
          context.fillStyle = "#277e91";
          context.fillRect(0, 0, 96, 96);
          context.fillStyle = "#f8c66a";
          context.beginPath();
          context.arc(60, 34, 19, 0, Math.PI * 2);
          context.fill();
          return canvas.toDataURL().split(",")[1]!;
        });
        await composer.locator(".agent-chat__file-input").setInputFiles(
          Array.from({ length: 12 }, (_, index) => ({
            name: `sample-${index + 1}.png`,
            mimeType: "image/png",
            buffer: Buffer.from(png, "base64"),
          })),
        );
        const rail = composer.locator(".chat-attachments-preview");
        const thumbnails = rail.locator(".chat-attachment-thumb");
        await expect.poll(() => thumbnails.count()).toBe(12);
        await expect.poll(() => rail.locator('[aria-busy="true"]').count()).toBe(0);
        await expect.poll(() => rail.getAttribute("data-scrollable")).toBe("true");
        await page.screenshot({
          path: path.join(suite.artifactDir, "attachments.png"),
          animations: "disabled",
        });

        const containment = await rail.evaluate((element) => {
          const surface = element.closest<HTMLElement>(".agent-chat__input")!;
          const outer = surface.getBoundingClientRect();
          const inner = element.getBoundingClientRect();
          return {
            leftOverflow: outer.left - inner.left,
            rightOverflow: inner.right - outer.right,
            surfaceOverflow: surface.scrollWidth - surface.clientWidth,
            canScroll: element.scrollWidth > element.clientWidth,
          };
        });
        expect(containment.canScroll).toBe(true);
        expect(containment.leftOverflow).toBeLessThanOrEqual(0);
        expect(containment.rightOverflow).toBeLessThanOrEqual(0);
        expect(containment.surfaceOverflow).toBeLessThanOrEqual(1);

        await rail.evaluate((element) => {
          element.scrollLeft = element.scrollWidth;
        });
        await expect.poll(() => rail.getAttribute("data-at-end")).toBe("true");
        const remove = thumbnails.last().getByRole("button", { name: "Remove sample-12.png" });
        await remove.focus();
        const target = await remove.evaluate(async (element) => {
          await Promise.all(element.getAnimations().map((animation) => animation.finished));
          const box = element.getBoundingClientRect();
          return {
            x: box.right - 1,
            y: box.top + box.height / 2,
            width: box.width,
            height: box.height,
          };
        });
        expect(target.width).toBeGreaterThanOrEqual(44);
        expect(target.height).toBeGreaterThanOrEqual(44);
        await page.touchscreen.tap(target.x, target.y);
        await expect.poll(() => thumbnails.count()).toBe(11);
      });
    },
  );
});
