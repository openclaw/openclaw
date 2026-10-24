import { expect, type Page } from "playwright/test";
import { it } from "vitest";
import {
  GIT_COAUTHOR_PREFERENCE_KEY,
  type UserProfile,
} from "../../../packages/gateway-protocol/src/index.ts";
import type { MockGatewayControls } from "../test-helpers/control-ui-e2e.ts";
import type { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

export function defineProfilePreferenceTests({
  suite,
  testProfile,
  openProfilePage,
  screenshot,
  captureUiProof,
  getProofDir,
}: {
  suite: ReturnType<typeof createControlUiE2eSuite>;
  testProfile: UserProfile;
  openProfilePage: (
    page: Page,
    methodResponses?: Record<string, unknown>,
  ) => Promise<MockGatewayControls>;
  screenshot: (page: Page, name: string) => Promise<void>;
  captureUiProof: boolean;
  getProofDir: () => string;
}) {
  const githubAvatarUrl = "https://avatars.githubusercontent.com/u/583231?v=4";
  const linkedGitHubProfile = {
    ...testProfile,
    githubIdentity: {
      login: "octocat",
      profileUrl: "https://github.com/octocat",
      avatarUrl: githubAvatarUrl,
    },
  };

  it.each([
    {
      issuer: "public",
      profile: linkedGitHubProfile,
    },
    {
      issuer: "enterprise",
      profile: {
        ...linkedGitHubProfile,
        githubIdentity: {
          ...linkedGitHubProfile.githubIdentity,
          host: "ghe.example.test",
          profileUrl: "https://ghe.example.test/octocat",
          avatarUrl: "https://ghe.example.test/avatars/u/583231",
        },
      },
    },
  ])(
    "shows $issuer sign-in verification separately from explicit Git co-author credit",
    async ({ profile }) => {
      await suite.withPage(
        {
          ...(captureUiProof
            ? { recordVideo: { dir: getProofDir(), size: { width: 1280, height: 800 } } }
            : {}),
          viewport: { width: 1280, height: 800 },
        },
        async ({ page }) => {
          const avatarRequests: string[] = [];
          const avatarUrl = profile.githubIdentity.avatarUrl;
          await page.route(avatarUrl, async (route) => {
            avatarRequests.push(route.request().url());
            await route.fulfill({
              body: `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="#24292f"/><circle cx="32" cy="27" r="14" fill="white"/><path d="M12 62c2-15 10-23 20-23s18 8 20 23" fill="white"/></svg>`,
              contentType: "image/svg+xml",
              status: 200,
            });
          });
          const gateway = await openProfilePage(page, {
            "users.self": { profile: testProfile },
            "users.prefs.get": {
              status: "ok",
              entries: { [GIT_COAUTHOR_PREFERENCE_KEY]: false },
            },
            "users.prefs.set": { status: "ok" },
          });

          const githubRow = page
            .locator("#settings-profile-identity .settings-row")
            .filter({ has: page.locator(".settings-row__title", { hasText: "GitHub account" }) });
          const coauthorRow = page.locator("#settings-profile-identity .settings-row").filter({
            has: page.locator(".settings-row__title", { hasText: "Git co-author credit" }),
          });
          await expect(githubRow).toContainText("Unavailable");
          await expect(githubRow).toContainText("No single verified GitHub sign-in account");
          await expect(githubRow.locator(".settings-account")).toHaveCount(0);
          await expect(
            coauthorRow.getByRole("switch", { name: "Git co-author credit" }),
          ).toBeEnabled();
          await expect(page.getByRole("textbox", { name: "GitHub username" })).toHaveCount(0);
          await expect(
            page
              .locator("#settings-profile-identity")
              .getByRole("button", { name: /Link GitHub|Change|Disconnect/u }),
          ).toHaveCount(0);
          await screenshot(page, "08-github-identity-unlinked.png");

          await gateway.setMethodResponse("users.self", { profile });
          const readsBeforeRefresh = (await gateway.getRequests("users.self")).length;
          await page.locator(".profile-refresh").click();
          await gateway.waitForRequest("users.self", { after: readsBeforeRefresh });
          const prefGet = await gateway.waitForRequest("users.prefs.get");
          expect(prefGet.params).toEqual({
            keys: [GIT_COAUTHOR_PREFERENCE_KEY, "github.prAttribution.enabled"],
          });
          const account = githubRow.getByRole("link", { name: "@octocat" });
          await expect(account).toBeVisible();
          await expect(account).toHaveAttribute("href", profile.githubIdentity.profileUrl);
          await expect(account).toHaveAttribute("target", "_blank");
          await account.focus();
          await expect(account).toBeFocused();
          const avatar = account.locator("img");
          await expect(avatar).toBeVisible();
          await expect(avatar).toHaveAttribute("src", avatarUrl);
          await expect
            .poll(() => avatar.evaluate((image) => (image as HTMLImageElement).naturalWidth))
            .toBe(64);
          expect(avatarRequests).toEqual([avatarUrl]);
          await expect(githubRow).toContainText("Verified from your GitHub-backed sign-in");
          await screenshot(page, "09-github-identity-linked.png");
          // A public primary can also hold enterprise credit after explicit profile linking.
          await expect(coauthorRow).toContainText("public GitHub noreply address");
          await expect(coauthorRow).toContainText("verified enterprise email address");
          await expect(coauthorRow).toContainText("visible in commit history");
          await expect(coauthorRow).toContainText("future commits only");
          const toggle = coauthorRow.getByRole("switch", { name: "Git co-author credit" });
          await expect(toggle).toBeEnabled();
          await expect(toggle).not.toBeChecked();

          await toggle.click();
          const prefSet = await gateway.waitForRequest("users.prefs.set");
          expect(prefSet.params).toEqual({
            entries: { [GIT_COAUTHOR_PREFERENCE_KEY]: true },
          });
          await expect(toggle).toBeChecked();
          await screenshot(page, "10-git-coauthor-enabled.png");
        },
      );
    },
  );

  it("keeps co-author consent editable for merged enterprise hosts without a display primary", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 800 } }, async ({ page }) => {
      const gateway = await openProfilePage(page, {
        "users.self": {
          profile: {
            ...testProfile,
            emails: ["github:ghe.example.test:101", "github:code.example.test:101"],
            githubIdentity: null,
          },
        },
        "users.prefs.get": { status: "ok", entries: {} },
        "users.prefs.set": { status: "ok" },
      });
      const identity = page.locator("#settings-profile-identity");
      const toggle = identity.getByRole("switch", { name: "Git co-author credit" });
      // Capture before the changed assertion so the same scenario records the original defect.
      await screenshot(page, "14-multi-host-consent-initial.png");
      await expect(toggle).toBeEnabled();
      await expect(toggle).toBeChecked();
      await toggle.click();
      const saved = await gateway.waitForRequest("users.prefs.set");
      expect(saved.params).toEqual({ entries: { [GIT_COAUTHOR_PREFERENCE_KEY]: false } });
      await expect(toggle).not.toBeChecked();
    });
  });

  it("credits a verified GitHub account by default with no stored preference", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 800 } }, async ({ page }) => {
      await openProfilePage(page, {
        "users.self": { profile: linkedGitHubProfile },
        "users.prefs.get": { status: "ok", entries: {} },
      });

      const coauthorRow = page.locator("#settings-profile-identity .settings-row").filter({
        has: page.locator(".settings-row__title", { hasText: "Git co-author credit" }),
      });
      const toggle = coauthorRow.getByRole("switch", { name: "Git co-author credit" });
      await expect(toggle).toBeEnabled();
      await expect(toggle).toBeChecked();
      await screenshot(page, "13-git-coauthor-default-on.png");
    });
  });

  it("persists personal PR attribution independently from Git co-author credit", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await openProfilePage(page, {
        "users.prefs.get": { status: "ok", entries: {} },
        "users.prefs.set": { status: "ok" },
      });
      const identity = page.locator("#settings-profile-identity");
      const toggle = identity.getByRole("switch", {
        name: "Add OpenClaw attribution to pull requests",
      });
      const coauthor = identity.getByRole("switch", { name: "Git co-author credit" });
      await expect(toggle).toBeEnabled();
      await expect(toggle).not.toBeChecked();
      await expect(coauthor).toBeChecked();
      await expect(identity.getByRole("link", { name: "🦞 Made with OpenClaw" })).toHaveAttribute(
        "href",
        "https://openclaw.ai",
      );
      await screenshot(page, "15-pr-attribution-default-off.png");
      await toggle.click();
      const saved = await gateway.waitForRequest("users.prefs.set");
      expect(saved.params).toEqual({ entries: { "github.prAttribution.enabled": true } });
      await expect(toggle).toBeChecked();
      await expect(coauthor).toBeChecked();
      await screenshot(page, "16-pr-attribution-enabled.png");
      await gateway.setMethodResponse("users.prefs.get", {
        status: "ok",
        entries: { "github.prAttribution.enabled": true },
      });
      const reads = (await gateway.getRequests("users.prefs.get")).length;
      await page.locator(".profile-refresh").click();
      await gateway.waitForRequest("users.prefs.get", { after: reads });
      await expect(toggle).toBeEnabled();
      await expect(toggle).toBeChecked();
      await toggle.click();
      const disabled = await gateway.waitForRequest("users.prefs.set", { after: 1 });
      expect(disabled.params).toEqual({ entries: { "github.prAttribution.enabled": false } });
      await expect(toggle).not.toBeChecked();
      await expect(coauthor).toBeChecked();
    });
  });
}
