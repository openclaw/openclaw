import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "User avatar alignment" });

suite.define(() => {
  it.each(["Review this image.\n\nKeep the sender beside this message.", '{"ok":true}'])(
    "keeps each shared-session sender and media on the text bubble side: %s",
    async (message) => {
      await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
        const imageUrl = "/api/chat/media/outgoing/avatar-alignment/image.svg";
        await page.route(`**${imageUrl}`, (route) =>
          route.fulfill({
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="teal"/></svg>',
          }),
        );
        const participants = [
          { id: "avatar-sender", name: "Alex", self: true },
          { id: "avatar-peer", name: "Riley", self: false },
        ];
        await installMockGateway(page, {
          hasMultipleSessionSharingIdentities: true,
          sessions: [{ key: "agent:main:main", visibility: "shared", sharingRole: "owner" }],
          presenceUsers: participants.map((participant) => ({
            ...participant,
            identity: { type: "profile", id: participant.id },
            avatarUrl: imageUrl,
          })),
          historyMessages: participants.map((participant) => ({
            role: "user",
            __openclaw: {
              senderId: participant.id,
              senderIdentity: { type: "profile", id: participant.id },
              senderName: participant.name,
            },
            content: [
              { type: "image", url: imageUrl, alt: "Attached image" },
              { type: "text", text: message },
            ],
          })),
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 900 });
          for (const [index, participant] of participants.entries()) {
            const group = page.locator(".chat-group.user").nth(index);
            const media = group.locator(".chat-message-image");
            await media.waitFor();
            await media.evaluate((image: HTMLImageElement) => image.decode());
            const text = group.locator(".chat-text, .chat-json-collapse");
            const surface = await text.evaluate((element) => {
              let painted = element;
              while (getComputedStyle(painted).backgroundColor === "rgba(0, 0, 0, 0)") {
                painted = painted.parentElement!;
              }
              const { x, y, width: surfaceWidth, height } = painted.getBoundingClientRect();
              return { x, y, width: surfaceWidth, height };
            });
            const mediaBox = (await media.boundingBox())!;
            const mediaEdge = participant.self ? mediaBox.x + mediaBox.width : mediaBox.x;
            const textEdge = participant.self ? surface.x + surface.width : surface.x;
            expect(Math.abs(mediaEdge - textEdge)).toBeLessThanOrEqual(1);
            expect(surface.y).toBeGreaterThan(mediaBox.y + mediaBox.height);
            const avatar = group.locator(".chat-avatar:visible");
            if (width === 390) {
              await expect.poll(() => avatar.count()).toBe(0);
              expect(mediaBox.x).toBeGreaterThanOrEqual(0);
              expect(mediaBox.x + mediaBox.width).toBeLessThanOrEqual(width);
            } else {
              await avatar.waitFor();
              const avatarBox = (await avatar.boundingBox())!;
              expect(Math.abs(avatarBox.y - surface.y)).toBeLessThanOrEqual(1);
              if (participant.self) {
                expect(avatarBox.x).toBeGreaterThan(surface.x + surface.width);
              } else {
                expect(avatarBox.x + avatarBox.width).toBeLessThan(surface.x);
              }
              expect(await avatar.count()).toBe(1);
            }
          }
        }
      });
    },
  );
});
