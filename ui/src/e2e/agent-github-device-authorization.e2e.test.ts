import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "playwright/test";
import { it } from "vitest";
import { registerGitHubConnectionsEnglish } from "../i18n/locales/en-github-connections.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { pickerValue, selectPickerValue } from "../test-helpers/select-picker-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const githubCopy = registerGitHubConnectionsEnglish.catalog;

const suite = createControlUiE2eSuite({
  name: "Control UI GitHub connections",
  startServerBeforeBrowser: true,
});
async function assertDeviceCodeCopy(page: Page, userCode: string) {
  const deviceCode = page.getByText(userCode, { exact: true });
  const authorizationHint = page.getByText("Open GitHub, then enter this one-time code.", {
    exact: true,
  });
  await authorizationHint.dblclick();
  expect(await page.evaluate(() => globalThis.getSelection()?.toString())).not.toBe("");
  await deviceCode.click();
  expect(await page.evaluate(() => globalThis.getSelection()?.toString())).toBe(userCode);
  const copyCode = page.getByRole("button", { name: "Copy code", exact: true });
  const codeBox = await deviceCode.boundingBox();
  const copyBox = await copyCode.boundingBox();
  if (!codeBox || !copyBox) {
    throw new Error("Device code and copy button must be visible");
  }
  expect(Math.abs(codeBox.y + codeBox.height / 2 - copyBox.y - copyBox.height / 2)).toBeLessThan(4);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await copyCode.click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(userCode);
  await expect(page.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
}
const disconnected = {
  state: "disconnected",
  generation: null,
  account: null,
  accessExpiresAtMs: null,
  refreshState: "not_applicable",
  pending: null,
} as const;
const system = {
  source: "system-configured",
  credentialKind: "managed-oauth",
  credentialState: "available",
  account: { login: "system-octocat" },
  gitAuthor: { name: "System Octocat", email: null },
  evidence: "github-api",
  accessExpiresAtMs: 1_900_000_000_000,
  refreshState: "available",
  oauthScopes: ["gist", "read:org", "repo", "workflow"],
  repositoryGrants: "unknown",
} as const;
const device = {
  requestId: "33333333-3333-4333-8333-333333333333",
  userCode: "ABCD-1234",
  verificationUri: "https://github.com/login/device",
  expiresInMs: 60_000,
  pollAfterMs: 1_000,
};
suite.define(() => {
  it.each([
    ["R0", "operator.read.no-credential-enrollment", false],
    ["W0", "operator.write.no-credential-enrollment", true],
  ] as const)(
    "keeps saved credentials and profile identity separate from enrollment with %s",
    async (label, scope, canWrite) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { height: 960, width: 1280 } },
        async ({ page }) => {
          const profile = {
            id: "11111111-1111-4111-8111-111111111111",
            displayName: "Test Person",
            avatarMime: null,
            mergedInto: null,
            createdAt: 1,
            updatedAt: 2,
            emails: ["person@example.test"],
            hasAvatar: false,
            githubIdentity: {
              accountId: 101,
              login: "synthetic-person",
              profileUrl: "https://github.com/synthetic-person",
              avatarUrl: "/synthetic-gh-avatar.svg",
            },
          };
          await page.route("**/synthetic-gh-avatar.svg", (route) =>
            route.fulfill({
              contentType: "image/svg+xml",
              body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#2563eb"/></svg>',
            }),
          );
          const personal = {
            ...disconnected,
            state: "connected",
            generation: "22222222-2222-4222-8222-222222222222",
            account: { accountId: 2, login: "personal-octocat" },
            refreshState: "available",
          };
          const saved = [
            {
              provider: "openai",
              authProfileId: "openai:personal",
              label: "Personal workspace",
              authType: "oauth",
              selected: true,
            },
            {
              provider: "openai",
              authProfileId: "openai:work",
              label: "Work workspace",
              authType: "oauth",
              selected: false,
            },
          ] as const;
          const gateway = await installMockGateway(page, {
            operatorScopes: [scope],
            presenceUsers: [{ self: true, id: profile.id, name: profile.displayName }],
            methodResponses: {
              "users.self": { profile },
              "users.github.status": { personal, system },
              "users.listModelAccounts": {
                profileId: profile.id,
                accounts: saved,
                links: [
                  { provider: "openai", authProfileId: saved[0].authProfileId, updatedAt: 1 },
                ],
              },
            },
          });
          await page.goto(`${suite.server.baseUrl}settings/profile`);
          const github = page.locator("#settings-profile-github-connections");
          const models = page.locator("openclaw-model-accounts");
          const identity = page.locator("#settings-profile-identity");
          await expect(identity).toContainText("@synthetic-person");
          await expect(identity.getByText("GitHub sign-in", { exact: true })).toBeVisible();
          await expect(identity.getByText("Verified", { exact: true })).toBeVisible();
          const coauthor = page.getByRole("switch", { name: "Git co-author credit", exact: true });
          await expect(coauthor).toBeEnabled();
          const coauthorPreference = await coauthor.isChecked();
          await expect(github).toContainText("@personal-octocat");
          const personalConnection = github.locator('[data-github-connection="personal"]');
          const manageLabel = githubCopy.githubConnections.manage;
          await expect(
            personalConnection.getByRole("button", { name: manageLabel, exact: true }),
          ).toBeEnabled();
          await expect(github.getByRole("button", { name: "Verify", exact: true })).toBeEnabled();
          await personalConnection.getByRole("button", { name: manageLabel, exact: true }).click();
          const setup = personalConnection.locator("[data-github-setup]");
          await expect(setup).toBeVisible();
          await expect(setup).toContainText("Access required");
          await expect(
            setup.getByRole("button", { name: "Continue with GitHub", exact: true }),
          ).toHaveCount(0);
          await expect(
            personalConnection.getByRole("button", { name: "Change My GitHub", exact: true }),
          ).toHaveCount(0);
          await expect(
            setup.getByRole("button", { name: "Disconnect", exact: true }),
          ).toBeEnabled();
          const proofDir =
            process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
              ? createControlUiE2eArtifactDir(`credential-enrollment-${label}`)
              : null;
          const capture = async (surface: ReturnType<Page["locator"]>, name: string) => {
            if (!proofDir) {
              return;
            }
            const frame = await takeControlUiScreenshotFrame(
              page,
              surface,
              [surface.locator(".settings-section__heading").first()],
              { animations: "disabled", scrollTo: surface, elements: [surface] },
            );
            await writeFile(path.join(proofDir, name), frame.elements[0]!.png);
          };
          if (canWrite) {
            await expect(models.locator(".profile-auth-add-account")).toBeDisabled();
            const accountPicker = models.locator(".profile-auth-account-picker");
            await expect(accountPicker.locator(".picker-select__trigger")).toBeEnabled();
            await capture(models, "after-provider-saved-accounts.png");
            await gateway.setMethodResponse("users.selectModelAccount", {
              links: [{ provider: "openai", authProfileId: saved[1].authProfileId, updatedAt: 2 }],
            });
            await gateway.setMethodResponse("users.listModelAccounts", {
              profileId: profile.id,
              accounts: saved.map((account) => ({
                ...account,
                selected: account.authProfileId === saved[1].authProfileId,
              })),
              links: [{ provider: "openai", authProfileId: saved[1].authProfileId, updatedAt: 2 }],
            });
            await selectPickerValue(accountPicker, saved[1].authProfileId);
            expect((await gateway.waitForRequest("users.selectModelAccount")).params).toEqual({
              profileId: profile.id,
              authProfileId: saved[1].authProfileId,
            });
            await expect.poll(() => pickerValue(accountPicker)).toBe(saved[1].authProfileId);
            await gateway.setMethodResponse("users.unlinkAuthProfile", { links: [] });
            await gateway.setMethodResponse("users.listModelAccounts", {
              profileId: profile.id,
              accounts: saved.map((account) => Object.assign({}, account, { selected: false })),
              links: [],
            });
            await selectPickerValue(accountPicker, "gateway-default");
            expect((await gateway.waitForRequest("users.unlinkAuthProfile")).params).toEqual({
              profileId: profile.id,
              provider: "openai",
            });
            await expect.poll(() => pickerValue(accountPicker)).toBe("gateway-default");
          } else {
            await expect(models).toBeVisible();
            await expect(models).toContainText("Sign-in unavailable");
            await expect(models.locator(".profile-auth-account-picker")).toHaveCount(0);
            expect(await gateway.getRequests("users.selectModelAccount")).toHaveLength(0);
            expect(await gateway.getRequests("users.unlinkAuthProfile")).toHaveLength(0);
          }
          await capture(github, "after-github-connected.png");
          await capture(identity, "after-verified-profile-identity.png");
          await gateway.setMethodResponse("users.github.status", {
            personal: disconnected,
            system,
          });
          await setup.getByRole("button", { name: "Disconnect", exact: true }).click();
          expect((await gateway.waitForRequest("users.github.disconnect")).params).toEqual({});
          await expect(personalConnection).toContainText(githubCopy.agentTools.githubDisconnected);
          await expect(identity).toContainText("@synthetic-person");
          await expect(identity.getByText("Verified", { exact: true })).toBeVisible();
          await expect.poll(() => coauthor.isChecked()).toBe(coauthorPreference);
          for (const method of [
            "users.authConnect.start",
            "users.authConnect.answer",
            "users.github.authorize.start",
            "users.github.authorize.poll",
          ]) {
            expect(await gateway.getRequests(method), method).toHaveLength(0);
          }
        },
      );
    },
  );

  it("copies the personal device code and connects only the signed-in reader's GitHub", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 960, width: 1280 },
      },
      async ({ page }) => {
        const status = { personal: disconnected, system };
        const gateway = await installMockGateway(page, {
          operatorScopes: ["operator.read"],
          presenceUsers: [
            { self: true, id: "11111111-1111-4111-8111-111111111111", name: "Test Person" },
          ],
          methodResponses: { "users.github.status": status },
        });
        await page.goto(`${suite.server.baseUrl}settings/profile`);
        const section = page.locator("#settings-profile-github-connections");
        // Longer explanations stay one click away.
        const helpButton = section.locator(".settings-section__help-button");
        await helpButton.click();
        const help = page.locator(".settings-section__help-panel");
        await expect(help).toContainText("My GitHub is used only when");
        await expect(help).toContainText("Your account when you choose it to publish a PR.");
        await helpButton.click();
        await expect(help).toHaveCount(0);
        const button = (name: string) => section.getByRole("button", { name, exact: true });
        const connection = (scope: string) =>
          section.locator(`[data-github-connection="${scope}"]`);
        await expect(connection("system")).toContainText("@system-octocat");
        await expect(button("Change System GitHub")).toHaveCount(0);
        await expect(connection("agent")).toHaveCount(0);
        const configReads = (await gateway.getRequests("config.get")).length;
        const configWrites = (await gateway.getRequests("config.set")).length;
        await button(githubCopy.githubConnections.connectMine).click();
        await expect(connection("personal").locator("[data-github-setup]")).toBeVisible();
        await expect(connection("system").locator("[data-github-setup]")).toHaveCount(0);
        await expect(button("Use a PAT instead")).toHaveCount(0);
        await gateway.deferNext("users.github.authorize.start");
        await button("Continue with GitHub").click();
        expect((await gateway.waitForRequest("users.github.authorize.start")).params).toEqual({});
        await gateway.deferNext("users.github.authorize.poll");
        await gateway.resolveDeferred("users.github.authorize.start", device);
        await expect(section.getByText(device.userCode, { exact: true })).toBeVisible();
        await expect(
          section.getByRole("link", { name: "Open github.com/login/device" }),
        ).toHaveAttribute("href", device.verificationUri);
        await assertDeviceCodeCopy(page, device.userCode);
        await gateway.waitForRequest("users.github.authorize.poll");
        await gateway.resolveDeferred("users.github.authorize.poll", {
          status: "success",
          personal: {
            ...disconnected,
            state: "connected",
            generation: "22222222-2222-4222-8222-222222222222",
            account: { accountId: 2, login: "personal-octocat" },
            accessExpiresAtMs: 1_900_000_000_000,
            refreshState: "available",
          },
        });
        await expect(connection("personal")).toContainText("@personal-octocat");
        await expect(connection("system")).toContainText("@system-octocat");
        await expect(section.locator("[data-github-setup]")).toHaveCount(0);
        await expect(button("Continue with GitHub")).toHaveCount(0);
        await gateway.setMethodResponse("users.github.status", status);
        await button(githubCopy.githubConnections.changeMine).click();
        await button("Disconnect").click();
        expect((await gateway.waitForRequest("users.github.disconnect")).params).toEqual({});
        await expect(connection("personal")).toContainText("Disconnected");
        await expect(section).not.toContainText("@personal-octocat");
        expect(await gateway.getRequests("config.get")).toHaveLength(configReads);
        expect(await gateway.getRequests("config.set")).toHaveLength(configWrites);
        for (const method of [
          "tools.github.authorize.start",
          "secrets.store.set",
          "users.prefs.set",
        ]) {
          expect(await gateway.getRequests(method)).toHaveLength(0);
        }
      },
    );
  });
});
