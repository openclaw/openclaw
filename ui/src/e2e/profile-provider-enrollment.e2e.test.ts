// Control UI tests cover the settings profile page against a mocked Gateway.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "playwright/test";
import { beforeEach, it } from "vitest";
import {
  GIT_COAUTHOR_PREFERENCE_KEY,
  type UserModelAccount,
} from "../../../packages/gateway-protocol/src/index.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI personal credential enrollment scope E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("profile-credential-enrollment");
  }
});
const basePath = "/wilfred";
const profilePath = `${basePath}/settings/profile`;

const testProfile = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "Test Person",
  avatarMime: null,
  mergedInto: null,
  createdAt: 1,
  updatedAt: 2,
  emails: ["test@example.com"],
  githubIdentity: {
    login: "octocat",
    profileUrl: "https://github.com/octocat",
    avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
  },
  hasAvatar: false,
};
const testPresenceUsers: NonNullable<ControlUiMockGatewayScenario["presenceUsers"]> = [
  {
    self: true,
    id: testProfile.id,
    name: testProfile.displayName,
    email: testProfile.emails[0],
    avatarUrl: `/api/users/${testProfile.id}/avatar?v=${testProfile.updatedAt}`,
  },
];

suite.define(() => {
  async function openProfilePage(
    page: Page,
    methodResponses: Record<string, unknown> = {},
    presenceUsers = testPresenceUsers,
    operatorScopes?: string[],
  ) {
    await page.route(testProfile.githubIdentity.avatarUrl, (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="#24292f"/><circle cx="32" cy="27" r="14" fill="white"/></svg>',
      }),
    );
    const gateway = await installMockGateway(page, {
      basePath,
      presenceUsers,
      operatorScopes,
      methodResponses: {
        "users.self": { profile: testProfile },
        "users.prefs.get": { status: "ok", entries: { [GIT_COAUTHOR_PREFERENCE_KEY]: false } },
        "users.prefs.set": { status: "ok" },
        "agents.list": {
          defaultId: "clipper",
          agents: [{ id: "clipper", name: "Clipper" }],
        },
        ...methodResponses,
      },
    });
    const response = await page.goto(new URL(profilePath, suite.server.baseUrl).href);
    expect(response?.status()).toBe(200);
    return gateway;
  }

  it.each(["operator.write", "operator.write.no-credential-enrollment"])(
    "preserves profile and saved-account actions for %s",
    async (scope) => {
      const restricted = scope === "operator.write.no-credential-enrollment";
      await suite.withPage({ viewport: { width: 1280, height: 1400 } }, async ({ page }) => {
        const account: UserModelAccount = {
          authProfileId: "openai:retained",
          provider: "openai",
          label: "Test Person · Saved workspace",
          authType: "oauth",
          selected: false,
        };
        const links = [
          { provider: account.provider, authProfileId: account.authProfileId, updatedAt: 1 },
        ];
        const inventory = (selected: boolean) => ({
          profileId: testProfile.id,
          accounts: [{ ...account, selected }],
          links: selected ? links : [],
        });
        const gateway = await openProfilePage(
          page,
          {
            "users.listModelAccounts": inventory(false),
            "users.selectModelAccount": { links },
            "users.unlinkAuthProfile": { links: [] },
          },
          testPresenceUsers,
          [scope],
        );
        const section = page.locator("openclaw-model-accounts");
        await expect(section.getByRole("heading", { name: "Connected accounts" })).toBeVisible();
        await expect(page.locator(".identity-name-control input")).toBeEnabled();
        const addAccount = section.locator(".profile-auth-add-account");
        const enrollmentNotice = "Personal account sign-in requires operator.write access.";
        if (restricted) {
          await expect(addAccount).toBeDisabled();
          await expect(section).toContainText(enrollmentNotice);
        } else {
          await expect(addAccount).toBeEnabled();
          await expect(section).not.toContainText(enrollmentNotice);
        }
        await expect(section.locator(".profile-auth-account-select")).toBeEnabled();
        const github = page.locator("openclaw-github-connections");
        const connectGitHub = github.getByRole("button", {
          name: "Connect My GitHub",
          exact: true,
        });
        if (restricted) {
          await expect(connectGitHub).toBeDisabled();
        } else {
          await expect(connectGitHub).toBeEnabled();
        }
        await expect(github.getByRole("button", { name: "Verify", exact: true })).toBeEnabled();
        if (restricted) {
          await expect(github).toContainText(
            "Your access does not allow connecting or changing personal GitHub credentials.",
          );
          await expect(github).toContainText(
            "Verified GitHub identity and co-author credit remain available.",
          );
        }
        const identity = page.locator("#settings-profile-identity");
        await expect(identity.getByRole("link", { name: "@octocat" })).toBeVisible();
        await expect(identity).toContainText("Verified from your GitHub-backed sign-in");
        const coauthor = identity.getByRole("switch", { name: "Git co-author credit" });
        await expect(coauthor).toBeEnabled();
        await expect(coauthor).not.toBeChecked();
        await coauthor.click();
        expect((await gateway.waitForRequest("users.prefs.set")).params).toEqual({
          entries: { [GIT_COAUTHOR_PREFERENCE_KEY]: true },
        });
        await expect(coauthor).toBeChecked();
        if (captureUiProof) {
          // Capture current full vs. restricted grants, not a fabricated historical "before".
          // Save cropped controls alongside their original viewport frame.
          for (const [surface, content, name] of [
            [
              identity,
              [
                identity.getByRole("link", { name: "@octocat" }),
                identity.locator(".settings-toggle__control"),
              ],
              "identity-credit",
            ],
            [
              section,
              [addAccount, section.locator(".profile-auth-account-select")],
              "provider-credentials",
            ],
            [github, [connectGitHub], "github-credentials"],
          ] as const) {
            const frame = await takeControlUiScreenshotFrame(page, surface, content, {
              animations: "disabled",
              scrollTo: surface,
              elements: [surface],
            });
            const stem = ["profile", restricted ? "restricted-write" : "existing-write", name].join(
              "-",
            );
            await writeFile(path.join(proofDir, stem + "-frame.png"), frame.png);
            await writeFile(path.join(proofDir, stem + ".png"), frame.elements[0]!.png);
          }
        }
        await gateway.setMethodResponse("users.listModelAccounts", inventory(true));
        await section.locator(".profile-auth-account-select").click();
        await expect(section.locator(".profile-auth-link-unlink")).toBeEnabled();
        await gateway.setMethodResponse("users.listModelAccounts", inventory(false));
        await section.locator(".profile-auth-link-unlink").click();
        await expect(section.locator(".profile-auth-account-select")).toBeEnabled();
        expect(await gateway.getRequests("users.selectModelAccount")).toHaveLength(1);
        expect(await gateway.getRequests("users.unlinkAuthProfile")).toHaveLength(1);
        expect(await gateway.getRequests("users.authConnect.start")).toHaveLength(0);
        expect(await gateway.getRequests("users.authConnect.answer")).toHaveLength(0);
        if (restricted) {
          await expect(page.locator("[data-github-setup]")).toHaveCount(0);
        } else {
          await connectGitHub.click();
          await expect(page.locator("[data-github-setup]")).toBeVisible();
          await expect(github.getByRole("button", { name: "Continue with GitHub" })).toBeEnabled();
        }
        expect(await gateway.getRequests("users.github.authorize.start")).toHaveLength(0);
        expect(await gateway.getRequests("users.github.authorize.poll")).toHaveLength(0);
      });
    },
  );
});
