import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "playwright/test";
import { it } from "vitest";
import type { UserProfile } from "../../../packages/gateway-protocol/src/index.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
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
  it("edits and refreshes a member's own profile without roster or general write permission", async () => {
    await suite.withPage({ viewport: { width: 1200, height: 1000 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        basePath,
        operatorScopes: ["operator.sessions.write"],
        presenceUsers: [],
        methodResponses: {
          "users.self": { profile: testProfile },
          "users.prefs.get": { status: "ok", entries: {} },
          "users.prefs.set": { status: "ok" },
        },
      });
      await page.goto(new URL(profilePath, suite.server.baseUrl).href);
      await expect(page.locator(".profile-hero__name")).toHaveText(testProfile.displayName);
      await expect(page.getByRole("textbox", { name: "Display name", exact: true })).toHaveValue(
        testProfile.displayName,
      );
      await expect(page.getByRole("textbox", { name: "Display name", exact: true })).toBeEnabled();
      await expect(page.locator(".identity-name-control button")).toBeDisabled();
      expect(await page.locator('#settings-profile-identity input[type="file"]').count()).toBe(1);
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const directory = createControlUiE2eArtifactDir("member-profile");
        const identity = page.locator("#settings-profile-identity");
        const frame = await takeControlUiScreenshotFrame(
          page,
          identity,
          [identity.locator(".settings-section__heading")],
          { animations: "disabled", scrollTo: identity, elements: [identity] },
        );
        await writeFile(path.join(directory, "identity.png"), frame.elements[0]!.png);
      }
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
      const renamed = { ...testProfile, displayName: "My display name", updatedAt: 4 };
      await gateway.deferNext("users.setDisplayName");
      await page
        .getByRole("textbox", { name: "Display name", exact: true })
        .fill(renamed.displayName);
      await page.locator(".identity-name-control button").click();
      await gateway.waitForRequest("users.setDisplayName");
      await gateway.setMethodResponse("users.self", { profile: renamed });
      await gateway.resolveDeferred("users.setDisplayName", { profile: renamed });
      await expect(page.locator(".profile-hero__name")).toHaveText(renamed.displayName);
      expect(
        (await gateway.getRequests("users.setDisplayName")).map((request) => request.params),
      ).toEqual([{ profileId: testProfile.id, displayName: renamed.displayName }]);
      const credit = page.getByRole("switch", { name: "Git co-author credit", exact: true });
      await expect(credit).toBeEnabled();
      await expect(credit).toBeChecked();
      await credit.click();
      await expect.poll(async () => (await gateway.getRequests("users.prefs.set")).length).toBe(1);
      await expect(credit).not.toBeChecked();
      for (const method of ["users.setRole", "users.linkEmail", "users.merge", "config.set"]) {
        expect(await gateway.getRequests(method)).toHaveLength(0);
      }
    });
  });
});
