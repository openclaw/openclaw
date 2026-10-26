import type { Route } from "playwright";
import { expect, it } from "vitest";
import type { SessionMembersListEvidenceResult } from "../api/types.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const imageUrl =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180'%3E%3Crect width='320' height='180' fill='teal'/%3E%3C/svg%3E";
const viewer = { type: "profile" as const, id: "alex" };
const suite = createControlUiE2eSuite({ name: "User avatar alignment" });

suite.define(() => {
  it("keeps a verified proxy-authenticated portrait in its final frame across reload and decoding", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const requests: Route[] = [];
      let holdPhoto = false;
      const image = await page.request.get(
        new URL("apple-touch-icon.png", suite.server.baseUrl).href,
      );
      await page.route("**/api/users/riley/avatar*", (route) => {
        requests.push(route);
        if (!holdPhoto) {
          return route.fulfill({ response: image });
        }
        return undefined;
      });
      await installMockGateway(page, {
        authMethod: "trusted-proxy",
        authMode: "trusted-proxy",
        deviceToken: null,
        hasMultipleSessionSharingIdentities: true,
        sessions: [{ key: "agent:main:main", visibility: "shared", sharingRole: "owner" }],
        presenceUsers: [{ ...viewer, identity: viewer, self: true }],
        historyMessages: [
          {
            role: "user",
            content: [{ type: "text", text: "Review this portrait." }],
            __openclaw: {
              senderIdentity: { type: "profile", id: "riley" },
              senderName: "Riley",
              senderProfileAvatarUrl: "/api/users/riley/avatar?v=1",
            },
          },
        ],
      });
      try {
        await page.goto(`${suite.server.baseUrl}chat`, { waitUntil: "domcontentloaded" });
        const slot = page.locator(".chat-group.user .chat-avatar-slot");
        const portrait = slot.locator("img");
        await portrait.waitFor({ state: "visible" });
        await portrait.evaluate((element: HTMLImageElement) => element.decode());
        await expect
          .poll(() =>
            page.evaluate(() =>
              Object.keys(localStorage).some((key) =>
                key.startsWith("openclaw.control.bootRecord.v1:"),
              ),
            ),
          )
          .toBe(true);
        holdPhoto = true;
        requests.splice(0);
        await page.reload({ waitUntil: "domcontentloaded" });
        await slot.waitFor();
        await page.screenshot({ path: `${suite.artifactDir}/known-portrait-pending.png` });
        const before = await slot.evaluate((element) => ({
          attributes: element.getAttributeNames().map((name) => [name, element.getAttribute(name)]),
          bounds: element.getBoundingClientRect().toJSON(),
        }));
        expect(await portrait.getAttribute("src")).toBe(
          new URL("/api/users/riley/avatar?v=1", suite.server.baseUrl).href,
        );
        expect(await slot.getAttribute("data-avatar-state")).toBe("loaded");
        expect(await slot.ariaSnapshot()).toBe('- img "Riley"');
        await expect.poll(() => requests.length).toBeGreaterThan(0);
        await Promise.all(requests.map((route) => route.fulfill({ response: image })));
        await portrait.evaluate((element: HTMLImageElement) => element.decode());
        expect(await slot.ariaSnapshot()).toBe('- img "Riley"');
        expect(
          await slot.evaluate((element) => ({
            attributes: element
              .getAttributeNames()
              .map((name) => [name, element.getAttribute(name)]),
            bounds: element.getBoundingClientRect().toJSON(),
          })),
        ).toEqual(before);
      } finally {
        await Promise.all(requests.map((route) => route.abort().catch(() => undefined)));
      }
    });
  });

  it("keeps the painted avatar round while loading and preserves its size on failure", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const pending: Route[] = [];
      await page.route("**/api/users/riley/avatar*", (route) => {
        pending.push(route);
      });
      await installMockGateway(page, {
        hasMultipleSessionSharingIdentities: true,
        sessions: [{ key: "agent:main:main", visibility: "shared", sharingRole: "owner" }],
        presenceUsers: [{ ...viewer, identity: viewer, self: true }],
        historyMessages: [
          {
            role: "user",
            content: [{ type: "text", text: "Review this image." }],
            __openclaw: {
              senderIdentity: { type: "profile", id: "riley" },
              senderName: "Riley",
              senderProfileAvatarUrl: "/api/users/riley/avatar",
            },
          },
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await expect.poll(() => pending.length).toBeGreaterThan(0);
      const slot = page.locator(".chat-group.user .chat-avatar-slot");
      await expect.poll(() => slot.getAttribute("data-avatar-state")).toBe("pending");
      const loading = await slot.evaluate((element) => {
        const { width, height } = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const radius = style.borderTopLeftRadius;
        return {
          width,
          height,
          background: style.backgroundColor,
          rounded: radius.endsWith("%")
            ? Number.parseFloat(radius) >= 50
            : Number.parseFloat(radius) >= width / 2,
        };
      });
      expect.soft(loading.width).toBeGreaterThan(0);
      expect.soft(loading.height).toBe(loading.width);
      expect.soft(loading.rounded).toBe(true);
      expect.soft(loading.background).not.toBe("rgba(0, 0, 0, 0)");
      await Promise.all(pending.map((route) => route.fulfill({ status: 404, body: "Not found" })));
      const fallback = slot.locator(".chat-avatar:visible");
      await expect.poll(() => fallback.textContent()).toBe("R");
      const bounds = await fallback.boundingBox();
      expect(bounds?.width).toBe(loading.width);
      expect(bounds?.height).toBe(loading.height);
      expect(await slot.ariaSnapshot()).toBe('- img "Riley"');
    });
  });

  it.each([
    [true, "Review this image."],
    [false, "Review this image."],
    [true, "Review image.\nCheck heading.\nKeep spacing.\nShare notes.\nSend update."],
  ])("anchors the avatar beside the bubble (own=%s): %s", async (self, text) => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, {
        hasMultipleSessionSharingIdentities: true,
        methodResponses: {
          "session.members.listEvidence": {
            sessionKey: "agent:main:main",
            members: [],
            identities: [],
            role: "owner",
            allowedVisibilities: ["shared", "draft"],
          } satisfies SessionMembersListEvidenceResult,
        },
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
