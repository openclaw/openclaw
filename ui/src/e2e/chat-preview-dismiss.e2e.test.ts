import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

async function expectPreviewTarget(button: Locator, size: number) {
  const layout = await button.evaluate((element) => {
    const target = element.getBoundingClientRect();
    const preview = element.parentElement!.getBoundingClientRect();
    const text = element
      .parentElement!.querySelector(".chat-reply-preview__text")!
      .getBoundingClientRect();
    const icon = element.querySelector("svg")!.getBoundingClientRect();
    return {
      width: target.width,
      height: target.height,
      contained:
        target.left >= preview.left &&
        target.right <= preview.right &&
        target.top >= preview.top &&
        target.bottom <= preview.bottom,
      separate: text.right <= target.left || target.right <= text.left,
      iconWidth: icon.width,
      iconHeight: icon.height,
    };
  });
  expect(layout).toEqual({
    width: size,
    height: size,
    contained: true,
    separate: true,
    iconWidth: 16,
    iconHeight: 16,
  });
}

suite.define(() => {
  it.each([
    { width: 390, hasTouch: true, size: 44 },
    { width: 390, hasTouch: false, size: 44 },
    { width: 1280, hasTouch: true, size: 44 },
    { width: 1280, hasTouch: false, size: 20 },
  ])(
    "dismisses reply and mention previews at $width with touch=$hasTouch",
    async ({ width, hasTouch, size }) => {
      await suite.withPage(
        { viewport: { width, height: 900 }, hasTouch, reducedMotion: "reduce" },
        async ({ page }) => {
          const name = "مستخدم للاختبار باسم طويل";
          const gateway = await installMockGateway(page, {
            historyMessages: [
              {
                role: "user",
                content: "هذا نص طويل لاختبار معاينة الرد والتأكد من بقاء زر الإلغاء متاحاً ".repeat(
                  4,
                ),
                timestamp: 1_789_290_000_000,
                __openclaw: { id: "preview-reply-target", seq: 1 },
              },
            ],
            presenceUsers: [
              {
                self: true,
                id: "profile-alice",
                identity: { type: "profile", id: "profile-alice" },
                name: "Alice",
              },
            ],
            methodResponses: {
              "users.mentionable": {
                users: [{ profileId: "profile-bob", displayName: name, online: true }],
                truncated: false,
              },
            },
          });
          await page.goto(suite.server.baseUrl + "chat");
          const bubble = page.locator(".chat-group.user .chat-bubble");
          if (hasTouch) {
            await bubble.tap();
            await page.getByRole("button", { name: "Reply to message", exact: true }).tap();
          } else {
            await bubble.hover();
            await page.getByRole("button", { name: "Reply to message", exact: true }).click();
          }
          const cancel = page.getByRole("button", { name: "Cancel reply", exact: true });
          await cancel.waitFor();
          const textarea = page.locator(".agent-chat__composer-combobox textarea");
          await textarea.pressSequentially("@");
          await gateway.waitForRequest("users.mentionable");
          await page.getByRole("option", { name: new RegExp(name) }).click();
          const remove = page.getByRole("button", { name: "Remove mention", exact: true });
          await remove.waitFor();
          for (const direction of ["ltr", "rtl"]) {
            await page
              .locator(".agent-chat__composer-lede")
              .evaluate((element, dir) => element.setAttribute("dir", dir), direction);
            await expectPreviewTarget(cancel, size);
            await expectPreviewTarget(remove, size);
          }
          const draft = await textarea.inputValue();
          const url = page.url();
          // Activate the allocated edge, outside the compact icon, on touch devices.
          if (hasTouch) {
            await remove.tap({ position: { x: 2, y: 2 } });
          } else {
            await remove.click({ position: { x: 2, y: 2 } });
          }
          await expect.poll(() => remove.count()).toBe(0);
          expect(await textarea.inputValue()).toBe(draft);
          expect(await cancel.count()).toBe(1);
          await textarea.focus();
          await page.keyboard.press("Shift+Tab");
          await expect
            .poll(() => cancel.evaluate((element) => element === document.activeElement))
            .toBe(true);
          // Reduced motion still transitions the outline for 0.01 ms; focus can
          // arrive before that transition is painted. Await its actual completion.
          await cancel.evaluate(async (element) => {
            await Promise.all(element.getAnimations().map((animation) => animation.finished));
          });
          expect(
            await cancel.evaluate((element) => {
              const style = getComputedStyle(element);
              return (
                element.matches(":focus-visible") &&
                ((style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0) ||
                  style.boxShadow !== "none")
              );
            }),
          ).toBe(true);
          await page.keyboard.press("Enter");
          await expect.poll(() => cancel.count()).toBe(0);
          expect(await textarea.inputValue()).toBe(draft);
          expect(page.url()).toBe(url);
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        },
      );
    },
  );
});
