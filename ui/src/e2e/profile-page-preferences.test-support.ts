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
  const identity = (page: Page) => page.locator("#settings-profile-identity");
  const identityRow = (page: Page, title: string) =>
    identity(page)
      .locator(".settings-row")
      .filter({
        has: page.locator(".settings-row__title", { hasText: title }),
      });
  const coauthorSwitch = (page: Page) =>
    identity(page).getByRole("switch", { name: "Git co-author credit" });

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
          const avatarUrl = profile.githubIdentity.avatarUrl;
          await page.route(avatarUrl, async (route) => {
            await route.fulfill({
              body: `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="#24292f"/><circle cx="32" cy="27" r="14" fill="white"/><path d="M12 62c2-15 10-23 20-23s18 8 20 23" fill="white"/></svg>`,
              contentType: "image/svg+xml",
              status: 200,
            });
          });
          await openProfilePage(page, {
            "users.self": { profile },
            "users.prefs.get": {
              status: "ok",
              entries: { [GIT_COAUTHOR_PREFERENCE_KEY]: false },
            },
          });

          const githubRow = identityRow(page, "GitHub account");
          const coauthorRow = identityRow(page, "Git co-author credit");
          await expect(page.getByRole("textbox", { name: "GitHub username" })).toHaveCount(0);
          await expect(
            identity(page).getByRole("button", { name: /Link GitHub|Change|Disconnect/u }),
          ).toHaveCount(0);
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
          await expect(githubRow).toContainText("Verified from your GitHub-backed sign-in");
          await screenshot(page, "09-github-identity-linked.png");
          await expect(coauthorRow).toContainText("future commits only");
          const toggle = coauthorSwitch(page);
          await expect(toggle).toBeEnabled();
          await expect(toggle).not.toBeChecked();
          await expect(
            identity(page).getByRole("link", { name: "🦞 Made with OpenClaw" }),
          ).toHaveAttribute("href", "https://openclaw.ai");
        },
      );
    },
  );
}
