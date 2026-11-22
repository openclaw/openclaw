import { expect } from "playwright/test";
import { it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Profile account status layout" });
const profile = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "Profile reader",
  avatarMime: null,
  mergedInto: null,
  createdAt: 1,
  updatedAt: 2,
  emails: ["reader@example.test"],
  githubIdentity: null,
  hasAvatar: false,
};

suite.define(() => {
  it("scales the profile name and keeps the verified login readable at 140% text", async () => {
    await suite.withPage(
      { viewport: { width: 390, height: 844 }, hasTouch: true },
      async ({ page }) => {
        const login = "northwest-workshop-documentation-review";
        await page.addInitScript(
          (key) => localStorage.setItem(key, JSON.stringify({ textScale: 140 })),
          controlUiBundledSettingsStorageKey(suite.server.baseUrl),
        );
        await installMockGateway(page, {
          presenceUsers: [{ self: true, id: profile.id, name: profile.displayName }],
          methodResponses: {
            "users.self": {
              profile: {
                ...profile,
                githubIdentity: { login, profileUrl: "https://github.com/" + login, avatarUrl: "" },
              },
            },
          },
        });
        await page.goto(new URL("/settings/profile", suite.server.baseUrl).href);
        const name = page.locator(".profile-hero__name");
        await expect(name).toHaveText(profile.displayName);
        await expect.soft(name).toHaveCSS("font-size", "28px");
        await expect
          .soft(page.locator(".identity-emails .identity-account"))
          .toHaveCSS("font-size", "19.6px");
        const account = page.getByRole("link", { name: "@" + login, exact: true });
        await account.focus();
        await expect(account).toBeFocused();
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        expect(
          await account.evaluate((link) => {
            const range = document.createRange();
            range.selectNodeContents(link);
            const text = range.getBoundingClientRect(),
              box = link.getBoundingClientRect();
            return (
              text.width > 0 &&
              text.left >= box.left - 1 &&
              text.right <= box.right + 1 &&
              text.bottom <= box.bottom + 1
            );
          }),
        ).toBe(true);
      },
    );
  });
  it.each([
    { name: "unavailable", accounts: [] },
    {
      name: "linked",
      accounts: [{ accountId: "default", available: true, senderIds: ["123456789012345678"] }],
    },
  ])("keeps mobile account geometry when Discord becomes $name", async ({ accounts }) => {
    await suite.withPage({ viewport: { width: 390, height: 844 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        presenceUsers: [{ self: true, id: profile.id, name: profile.displayName }],
        heldMethods: ["users.channelIdentity"],
        methodResponses: { "users.self": { profile } },
      });
      await page.goto(new URL("/settings/profile", suite.server.baseUrl).href);
      await expect(page.getByRole("textbox", { name: "Display name", exact: true })).toBeEnabled();
      await gateway.waitForRequest("users.channelIdentity");
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const row = page.locator(".settings-row").filter({
        has: page.locator(".settings-row__title", { hasText: "Discord account" }),
      });
      const control = row.locator(".settings-row__control");
      await expect(row.getByRole("button", { name: "Connect Discord" })).toHaveAttribute(
        "aria-busy",
        "true",
      );
      const pendingRow = await row.boundingBox();
      const pendingControl = await control.boundingBox();
      expect(pendingRow).not.toBeNull();
      expect(pendingControl).not.toBeNull();

      await gateway.resolveDeferred("users.channelIdentity", { status: "ready", accounts });
      await expect(row.getByRole("button")).not.toHaveAttribute("aria-busy", "true");
      await expect(row).toContainText(accounts.length ? "Verified" : "Ask an admin to enable it.");
      expect(await row.boundingBox()).toEqual(pendingRow);
      expect(await control.boundingBox()).toEqual(pendingControl);
    });
  });
});
