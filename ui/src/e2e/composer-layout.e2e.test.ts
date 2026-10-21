import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Composer border width preference" });

suite.define(() => {
  it.each([1440, 1600])(
    "aligns New Session placement with saved and dragged widths at %ipx",
    async (viewportWidth) => {
      await suite.withPage(
        { viewport: { width: viewportWidth, height: 900 } },
        async ({ page }) => {
          await installMockGateway(page);
          await page.goto(`${suite.server.baseUrl}new`);
          const shell = page.locator(".agent-chat__composer-shell");
          const triggers = page.locator(".new-session-page__triggers");
          const edge = page.getByRole("separator", { name: "Resize message width", exact: true });
          await edge.waitFor();
          const width = () =>
            shell.evaluate((element) => Math.round(element.getBoundingClientRect().width));
          const alignment = () =>
            triggers.evaluate((element) =>
              Math.abs(
                element.getBoundingClientRect().left -
                  document.querySelector(".agent-chat__composer-shell")!.getBoundingClientRect()
                    .left,
              ),
            );
          const dragTo = async (target: number) => {
            const box = await edge.boundingBox();
            if (!box) {
              throw new Error("Expected a visible composer border");
            }
            const start = box.x + box.width / 2;
            await page.mouse.move(start, box.y + box.height / 2);
            await page.mouse.down();
            await page.mouse.move(start + ((await width()) - target) / 2, box.y + box.height / 2, {
              steps: 5,
            });
            await expect.poll(width).toBe(target);
          };
          await dragTo(600);
          await page.mouse.up();
          await expect
            .poll(() =>
              page
                .locator(".new-session-page")
                .evaluate((element) => element.style.getPropertyValue("--chat-thread-max-width")),
            )
            .toBe("600px");
          expect.soft(await alignment(), "saved 600px placement alignment").toBeLessThanOrEqual(1);
          await dragTo(480);
          expect(
            await page
              .locator(".new-session-page")
              .evaluate((element) => element.style.getPropertyValue("--chat-thread-drag-width")),
          ).toBe("480px");
          expect
            .soft(await alignment(), "active 480px drag placement alignment")
            .toBeLessThanOrEqual(1);
          await page.mouse.up();

          await page.setViewportSize({ width: 390, height: 844 });
          await page.locator(".shell--mobile-nav").waitFor();
          const mobileTriggers = triggers.locator("button:visible");
          expect(await mobileTriggers.count()).toBeGreaterThanOrEqual(2);
          for (const trigger of await mobileTriggers.all()) {
            const box = await trigger.boundingBox();
            expect(box!.x).toBeGreaterThanOrEqual(0);
            expect(box!.x + box!.width).toBeLessThanOrEqual(390);
            expect(box!.height).toBeGreaterThanOrEqual(44);
            await trigger.click({ trial: true });
          }
        },
      );
    },
  );

  it("shares width with chat and resets to the current preference after reopening New Session", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      await installMockGateway(page);
      const shell = page.locator(".agent-chat__composer-shell");
      const edge = page.getByRole("separator", { name: "Resize message width", exact: true });
      const width = () =>
        shell.evaluate((element) => Math.round(element.getBoundingClientRect().width));
      await page.goto(`${suite.server.baseUrl}new`);
      await edge.waitFor();
      const initial = await width();
      await edge.press("ArrowRight");
      await expect.poll(width).toBe(initial - 20);

      await page.goto(`${suite.server.baseUrl}chat`);
      await edge.waitFor();
      await expect.poll(width).toBe(initial - 20);
      await edge.press("ArrowRight");
      await expect.poll(width).toBe(initial - 40);

      await page.goto(`${suite.server.baseUrl}new`);
      await edge.waitFor();
      await expect.poll(width).toBe(initial - 40);
      await edge.dblclick();
      await expect.poll(width).toBe(initial - 40);
      await edge.press("ArrowLeft");
      await expect.poll(width).toBe(initial - 20);
      await edge.press("Enter");
      await expect.poll(width).toBe(initial - 40);

      const box = await edge.boundingBox();
      if (!box) {
        throw new Error("Expected a visible composer border");
      }
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 - 35, box.y + box.height / 2, { steps: 5 });
      await page.mouse.up();
      await expect.poll(width).toBe(initial + 30);
      await edge.dblclick();
      await expect.poll(width).toBe(initial - 40);
      const resetBox = await edge.boundingBox();
      if (!resetBox) {
        throw new Error("Expected the restored border");
      }
      await page.mouse.move(resetBox.x + 4, resetBox.y + resetBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(resetBox.x - 25, resetBox.y + resetBox.height / 2);
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await page.mouse.up();
      await expect.poll(width).toBe(initial - 40);
      expect(await edge.getAttribute("class")).not.toContain("--dragging");
      expect(
        await page
          .locator(".new-session-page")
          .evaluate((element) => element.style.getPropertyValue("--chat-thread-drag-width")),
      ).toBe("");
      await page.reload();
      await edge.waitFor();
      await expect.poll(width).toBe(initial - 40);
    });
  });
});
