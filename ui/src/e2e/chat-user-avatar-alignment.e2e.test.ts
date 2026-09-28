import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const imageUrl =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180'%3E%3Crect width='320' height='180' fill='teal'/%3E%3C/svg%3E";
const viewer = { type: "profile" as const, id: "alex" };
const suite = createControlUiE2eSuite({ name: "User avatar alignment" });

suite.define(() => {
  it.each([
    [true, "Review this image."],
    [false, "Review this image."],
    [true, "Review image.\nCheck heading.\nKeep spacing.\nShare notes.\nSend update."],
  ])("anchors the avatar beside the bubble (own=%s): %s", async (self, text) => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, {
        hasMultipleSessionSharingIdentities: true,
        sessions: [{ key: "agent:main:main", visibility: "shared", sharingRole: "owner" }],
        presenceUsers: [{ ...viewer, identity: viewer, self: true }],
        historyMessages: [
          {
            role: "user",
            __openclaw: {
              senderIdentity: { type: "profile", id: self ? "alex" : "riley" },
              senderName: self ? "Alex" : "Riley",
            },
            content: [
              { type: "image", url: imageUrl },
              { type: "text", text },
            ],
          },
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const visibleAvatar = page.locator(".chat-group.user .chat-avatar:visible");
      const [offset, leftGap, rightGap, height] = await visibleAvatar.evaluate((node) => {
        const group = node.closest(".chat-group")!;
        const body = group.querySelector(".chat-text")!.getBoundingClientRect();
        const box = node.getBoundingClientRect();
        return [box.y - body.y, body.x - box.right, box.x - body.right, body.height] as const;
      });
      expect(Math.abs(offset)).toBeLessThanOrEqual(1);
      expect(self ? rightGap : leftGap).toBeGreaterThan(0);
      if (text.includes("\n")) {
        expect(height).toBeGreaterThan(100);
      }
    });
  });
});
