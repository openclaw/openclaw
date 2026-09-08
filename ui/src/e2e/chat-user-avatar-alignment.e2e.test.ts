import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "User avatar alignment" });

suite.define(() => {
  it.each(["Review this image.\n\nKeep the sender beside this message.", '{"ok":true}'])(
    "anchors the sender to the text surface below media and keeps mobile avatars hidden: %s",
    async (message) => {
      await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
        const imageUrl = "/api/chat/media/outgoing/avatar-alignment/image.svg";
        await page.route(`**${imageUrl}`, (route) =>
          route.fulfill({
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="teal"/></svg>',
          }),
        );
        await installMockGateway(page, {
          presenceUsers: [
            {
              self: true,
              id: "avatar-sender",
              identity: { type: "profile", id: "avatar-sender" },
              name: "Alex",
              avatarUrl: imageUrl,
            },
          ],
          historyMessages: [
            {
              role: "user",
              __openclaw: {
                senderId: "avatar-sender",
                senderIdentity: { type: "profile", id: "avatar-sender" },
                senderName: "Alex",
              },
              content: [
                { type: "image", url: imageUrl, alt: "Attached image" },
                { type: "text", text: message },
              ],
            },
          ],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const group = page.locator(".chat-group.user");
        const media = group.locator(".chat-message-image");
        await media.waitFor();
        await media.evaluate((image: HTMLImageElement) => image.decode());
        const avatar = group.locator(".chat-avatar:visible");
        await avatar.waitFor();
        const text = group.locator(".chat-text, .chat-json-collapse");
        const textBox = (await text.boundingBox())!;
        const surfaceTop = await text.evaluate((element) => {
          let surface = element;
          while (getComputedStyle(surface).backgroundColor === "rgba(0, 0, 0, 0)") {
            surface = surface.parentElement!;
          }
          return surface.getBoundingClientRect().top;
        });
        const avatarBox = (await avatar.boundingBox())!;
        const mediaBox = (await media.boundingBox())!;
        expect(Math.abs(avatarBox.y - surfaceTop)).toBeLessThanOrEqual(1);
        expect(avatarBox.x).toBeGreaterThan(textBox.x + textBox.width);
        expect(avatarBox.y).toBeGreaterThan(mediaBox.y + mediaBox.height);
        expect(await avatar.count()).toBe(1);

        await page.setViewportSize({ width: 390, height: 844 });
        await expect.poll(() => avatar.count()).toBe(0);
        const mobileMedia = (await media.boundingBox())!;
        const mobileText = (await text.boundingBox())!;
        expect(mobileText.y).toBeGreaterThan(mobileMedia.y + mobileMedia.height);
        expect(mobileMedia.x).toBeGreaterThanOrEqual(0);
        expect(mobileMedia.x + mobileMedia.width).toBeLessThanOrEqual(390);
      });
    },
  );
});
