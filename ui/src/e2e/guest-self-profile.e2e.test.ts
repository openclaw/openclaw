import { expect } from "playwright/test";
import { it } from "vitest";
import type { UserProfile } from "../../../packages/gateway-protocol/src/index.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Guest self profile",
  startServerBeforeBrowser: true,
});
const basePath = "/guest-proof";
const profilePath = `${basePath}/settings/profile`;
const testProfile = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "Test Person",
  emails: ["test@example.test"],
  avatarMime: null,
  hasAvatar: false,
  githubIdentity: null,
  mergedInto: null,
  createdAt: 1,
  updatedAt: 2,
} satisfies UserProfile;

suite.define(() => {
  it("loads and refreshes a guest's own profile without roster or editing permission", async () => {
    await suite.withPage(undefined, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        basePath,
        operatorScopes: ["operator.sessions.write"],
        presenceUsers: [],
        methodResponses: { "users.self": { profile: testProfile } },
      });
      await page.goto(new URL(profilePath, suite.server.baseUrl).href);
      await expect(page.locator(".profile-hero__name")).toHaveText(testProfile.displayName);
      await expect(page.getByRole("textbox", { name: "Display name", exact: true })).toHaveValue(
        testProfile.displayName,
      );
      await expect(page.getByRole("textbox", { name: "Display name", exact: true })).toBeDisabled();
      await expect(page.locator(".identity-name-control button")).toBeDisabled();
      expect(await page.locator('#settings-profile-identity input[type="file"]').count()).toBe(0);
      const initialReads = (await gateway.getRequests("users.self")).length;
      expect(initialReads).toBeGreaterThan(0);
      await gateway.setMethodResponse("users.self", {
        profile: { ...testProfile, displayName: "Updated Person", updatedAt: 3 },
      });
      await gateway.emitGatewayEvent("sessions.changed", { reason: "profile-identity" });
      await expect(page.locator(".profile-hero__name")).toHaveText("Updated Person");
      await expect(page.getByRole("textbox", { name: "Display name", exact: true })).toHaveValue(
        "Updated Person",
      );
      await page.locator(".profile-refresh").click();
      await expect(page.locator(".profile-refresh")).toBeEnabled();
      expect(await gateway.getRequests("users.self")).toHaveLength(initialReads + 2);
      expect(await gateway.getRequests("users.list")).toHaveLength(0);
      for (const method of ["users.setDisplayName", "users.setAvatar", "users.prefs.set"]) {
        expect(await gateway.getRequests(method)).toHaveLength(0);
      }
    });
  });
});
