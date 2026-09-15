import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { UsersListResult } from "../../../packages/gateway-protocol/src/schema/users.js";
import {
  captureUiProof,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const label = "@Former Name";
const text = label + " cc " + label;
const historyMessages = [
  {
    role: "user",
    content: text,
    timestamp: 1,
    __openclaw: {
      id: "mention-message",
      humanMentions: [{ profileId: "profile-old", start: 0, end: label.length }],
    },
  },
];
const profile = {
  avatarMime: null,
  createdAt: 1,
  updatedAt: 2,
  emails: [],
  githubIdentity: null,
  hasAvatar: false,
  mergedInto: null,
};
const directory: UsersListResult = {
  profiles: [
    { ...profile, id: "same-name-not-selected", displayName: "Former Name" },
    { ...profile, id: "profile-old", displayName: "Former Name", mergedInto: "profile-ada" },
    { ...profile, id: "profile-ada", displayName: "Ada Lovelace", hasAvatar: true },
  ],
};

suite.define(() => {
  it.each(["keyboard", "mouse", "touch"] as const)(
    "opens explicit person cards with %s and keeps the original label",
    async (input) => {
      await suite.withPage(
        {
          viewport: { width: input === "touch" ? 390 : 1180, height: 800 },
          hasTouch: input === "touch",
          colorScheme: "dark",
        },
        async ({ page }) => {
          const avatarRequests: string[] = [];
          await page.route("**/api/users/**/avatar*", (route) => {
            avatarRequests.push(new URL(route.request().url()).pathname);
            return route.fulfill({
              contentType: "image/png",
              body: readFileSync("ui/public/apple-touch-icon.png"),
            });
          });
          const gateway = await installMockGateway(page, {
            historyMessages,
            methodResponses: { "users.list": directory },
          });
          await page.goto(suite.server.baseUrl + "chat");
          await page.locator(".chat-bubble").filter({ hasText: text }).waitFor();
          await captureUiProof(suite, page, "person-references", input + "-message.png");
          const reference = page.locator(".markdown-person-reference");
          await reference.waitFor();
          expect(await reference.count()).toBe(1);
          expect(await reference.textContent()).toBe(label);
          expect(
            await reference
              .locator("xpath=ancestor::*[contains(@class, 'chat-bubble')]")
              .getAttribute("data-message-text"),
          ).toBe(text);
          expect(await gateway.getRequests("users.list")).toHaveLength(0);
          if (input === "keyboard") {
            await reference.focus();
          } else if (input === "mouse") {
            await reference.hover();
          } else {
            await reference.tap();
          }
          const card = page.locator(".person-activity-hovercard[role=dialog]");
          await card.locator("h2").waitFor();
          expect(await card.locator("h2").textContent()).toBe("Ada Lovelace");
          const activity = card.getByRole("link", { name: "View activity" });
          expect(await activity.getAttribute("href")).toBe("/activity/profile-ada");
          await expect
            .poll(() =>
              card
                .locator("img")
                .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
            )
            .toBe(true);
          expect(avatarRequests).toContain("/api/users/profile-ada/avatar");
          await captureUiProof(suite, page, "person-references", input + "-card.png");
          expect(await reference.getAttribute("aria-expanded")).toBe("true");
          expect(await gateway.getRequests("users.list")).toHaveLength(1);
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          if (input === "keyboard") {
            await reference.press("Tab");
            expect(await activity.evaluate((node) => node === document.activeElement)).toBe(true);
            await activity.press("Escape");
            expect(await reference.evaluate((node) => node === document.activeElement)).toBe(true);
          } else if (input === "touch") {
            await reference.tap();
          } else {
            await page.locator(".agent-chat__composer-combobox textarea").hover();
          }
          await card.waitFor({ state: "detached" });
          expect(await reference.getAttribute("aria-expanded")).toBe("false");
          await reference.click();
          await activity.waitFor();
          await activity.click();
          await expect.poll(() => new URL(page.url()).pathname).toBe("/activity/profile-ada");
          await card.waitFor({ state: "detached" });
        },
      );
    },
  );

  it("does not revive a dismissed or disconnected card when an old directory reply arrives", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        historyMessages,
        deferredMethods: ["users.list"],
      });
      await page.goto(suite.server.baseUrl + "chat");
      const reference = page.locator(".markdown-person-reference");
      await reference.focus();
      await gateway.waitForRequest("users.list");
      const card = page.locator(".person-activity-hovercard");
      await card.waitFor();
      await reference.press("Escape");
      await gateway.resolveDeferred("users.list", directory);
      expect(await card.count()).toBe(0);
      await gateway.deferNext("users.list");
      await reference.click();
      await expect.poll(async () => (await gateway.getRequests("users.list")).length).toBe(2);
      await gateway.setOnline(false);
      await card.waitFor({ state: "detached" });
      await gateway.resolveDeferred("users.list", directory);
      expect(await card.count()).toBe(0);
    });
  });

  it.each([
    { profiles: [] },
    {
      profiles: [
        { ...profile, id: "profile-old", displayName: "Former Name", mergedInto: "profile-old" },
      ],
    },
  ])(
    "keeps missing and cyclic identities unresolved without guessing from labels",
    async (response) => {
      await suite.withPage({}, async ({ page }) => {
        await installMockGateway(page, {
          historyMessages,
          methodResponses: { "users.list": response },
        });
        await page.goto(suite.server.baseUrl + "chat");
        await page.locator(".markdown-person-reference").focus();
        const card = page.locator(".person-activity-hovercard");
        await expect.poll(() => card.textContent()).toContain("Could not load people");
        expect(await card.locator("a").count()).toBe(0);
        expect(await card.locator("openclaw-viewer-avatar").count()).toBe(0);
        await page.locator(".agent-chat__composer-combobox textarea").click();
        await card.waitFor({ state: "detached" });
      });
    },
  );
});
