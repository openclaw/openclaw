// Real Control UI browser flow with synthetic accounts and a mocked Gateway.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page } from "playwright/test";
import { it } from "vitest";
import type { UserModelAccount } from "../../../packages/gateway-protocol/src/index.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI personal account removal mocked Gateway E2E",
  startServerBeforeBrowser: true,
});
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = captureUiProof ? createControlUiE2eArtifactDir("model-account-removal") : "";
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
  githubIdentity: null,
  hasAvatar: false,
};

suite.define(() => {
  async function openProfilePage(page: Page, methodResponses: Record<string, unknown> = {}) {
    const gateway = await installMockGateway(page, {
      basePath,
      presenceUsers: [{ self: true, id: testProfile.id, name: testProfile.displayName }],
      methodResponses: {
        "users.self": { profile: testProfile },
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

  it("removes an account only after confirmation and offers retry for partial chat cleanup", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const removed: UserModelAccount = {
        authProfileId: `personal:${testProfile.id}:22222222-2222-4222-8222-222222222222`,
        provider: "openai",
        label: "Personal workspace",
        authType: "oauth",
        selected: true,
      };
      const kept: UserModelAccount = {
        authProfileId: `personal:${testProfile.id}:33333333-3333-4333-8333-333333333333`,
        provider: "openai",
        label: "Work workspace",
        authType: "oauth",
        selected: false,
      };
      const gateway = await openProfilePage(page, {
        "users.listModelAccounts": {
          profileId: testProfile.id,
          accounts: [removed, kept],
          links: [{ provider: "openai", authProfileId: removed.authProfileId, updatedAt: 1 }],
        },
        "users.removeModelAccount": {
          authProfileId: removed.authProfileId,
          removed: true,
          sessionCleanup: "pending",
          links: [],
        },
      });
      const section = page.locator("section.settings-section", {
        has: page.locator(".profile-auth-account-remove"),
      });
      const capture = async (name: string, anchor: Locator) => {
        if (captureUiProof) {
          await anchor.scrollIntoViewIfNeeded();
          await writeFile(
            path.join(proofDir, name),
            await takeControlUiViewportScreenshot(page, anchor, [anchor]),
          );
        }
      };
      const removeButton = page.getByRole("button", {
        name: "Remove account: OpenAI · Personal workspace",
        exact: true,
      });
      await expect(removeButton).toBeVisible();
      await capture("b1-before.png", section);
      await removeButton.click();
      const confirm = page.locator(".profile-auth-remove-confirm");
      await expect(confirm).toBeVisible();
      await capture("b1-confirm.png", confirm);
      await page.locator(".profile-auth-remove-cancel").click();
      expect(await gateway.getRequests("users.removeModelAccount")).toHaveLength(0);
      await expect(page.locator(".profile-auth-account-remove")).toHaveCount(2);
      await removeButton.click();
      await gateway.setMethodResponse("users.listModelAccounts", {
        profileId: testProfile.id,
        accounts: [kept],
        links: [],
      });
      await confirm.click();
      const request = await gateway.waitForRequest("users.removeModelAccount");
      expect(request.params).toEqual({
        profileId: testProfile.id,
        authProfileId: removed.authProfileId,
      });
      await expect(page.locator(".profile-auth-account-remove")).toHaveCount(1);
      await expect(confirm).toHaveText("Retry chat cleanup");
      await expect(page.locator(".model-accounts-notice")).toHaveCount(0);
      await capture("b1-partial.png", confirm);
      await gateway.setMethodResponse("users.removeModelAccount", {
        authProfileId: removed.authProfileId,
        removed: false,
        sessionCleanup: "complete",
        links: [],
      });
      await confirm.click();
      await expect(page.locator(".model-accounts-notice")).toHaveText(
        "Account removed from this Gateway and chat references cleared. Provider access was not revoked.",
      );
      await expect(page.locator(".profile-auth-account-remove")).toHaveCount(1);
      await expect(page.getByText("Work workspace", { exact: true })).toBeVisible();
      await capture("b1-after.png", section);
    });
  });
});
