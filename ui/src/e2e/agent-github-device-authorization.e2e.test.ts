import { expect, type Page } from "playwright/test";
import { it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI GitHub connections",
  startServerBeforeBrowser: true,
});
async function assertDeviceCodeCopy(page: Page, userCode: string) {
  const deviceCode = page.getByText(userCode, { exact: true });
  const authorizationHint = page.getByText(
    "Open GitHub yourself, then enter the one-time code shown here.",
    { exact: true },
  );
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
  await expect(page.getByRole("button", { name: "Copied!", exact: true })).toBeVisible();
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
        const button = (name: string) => section.getByRole("button", { name, exact: true });
        const connection = (scope: string) =>
          section.locator(`[data-github-connection="${scope}"]`);
        await expect(connection("system")).toContainText("@system-octocat");
        await expect(button("Change System GitHub")).toHaveCount(0);
        await expect(connection("agent")).toHaveCount(0);
        const configReads = (await gateway.getRequests("config.get")).length;
        const configWrites = (await gateway.getRequests("config.set")).length;
        await button("Connect My GitHub").click();
        await expect(section.getByText("For me", { exact: true })).toBeVisible();
        await expect(section.getByText("For the system", { exact: true })).toHaveCount(0);
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
        await button("Disconnect My GitHub").click();
        expect((await gateway.waitForRequest("users.github.disconnect")).params).toEqual({});
        await expect(connection("personal")).toContainText("Not connected");
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
