// Control UI tests cover the settings profile page against a mocked Gateway.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "playwright/test";
import { beforeEach, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { fulfillWithControlUiCsp } from "./control-ui-csp.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { defineProfilePreferenceTests } from "./profile-page-preferences.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI profile page mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("profile-identity");
  }
});
const avatarPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a6kAAAAASUVORK5CYII=",
  "base64",
);
const basePath = "/wilfred";
const profilePath = `${basePath}/settings/profile`;

async function screenshot(page: Page, name: string) {
  if (!captureUiProof) {
    return;
  }
  await page.bringToFront();
  const identity = page.locator("#settings-profile-identity");
  const frame = await takeControlUiScreenshotFrame(
    page,
    identity,
    [identity.locator(".settings-section__heading")],
    {
      animations: "disabled",
      scrollTo: identity,
      elements: [identity],
    },
  );
  await writeFile(path.join(proofDir, name), frame.elements[0]!.png);
}

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
  ) {
    const gateway = await installMockGateway(page, {
      basePath,
      presenceUsers,
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

  it("wraps an unnamed user's long email in both hero fields on narrow screens", async () => {
    const longEmail = "primaryuserprimaryuserprimaryuserprimaryuserprimaryuser@example.test";
    await suite.withPage({ viewport: { width: 360, height: 800 } }, async ({ page }) => {
      await openProfilePage(
        page,
        { "users.self": { profile: { ...testProfile, displayName: null, emails: [longEmail] } } },
        testPresenceUsers.map((user) => ({ ...user, name: undefined, email: longEmail })),
      );

      const title = page.locator(".profile-hero__name");
      const handle = page.locator(".profile-hero__handle");
      await expect(title).toHaveText(longEmail);
      await expect(handle).toContainText(longEmail);
      for (const field of [title, handle]) {
        await expect(field).toBeInViewport({ ratio: 1 });
        expect(await field.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );
      }
      expect(
        await page.locator("body").evaluate((element) => element.scrollWidth),
      ).toBeLessThanOrEqual(360);
    });
  });

  defineProfilePreferenceTests({
    suite,
    testProfile,
    openProfilePage,
    screenshot,
    captureUiProof,
    getProofDir: () => proofDir,
  });

  it("keeps keyboard editing and retry available after a rejected display-name save", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await openProfilePage(page);
      const input = page.getByRole("textbox", { name: "Display name", exact: true });
      const save = page.locator(".identity-name-control button");
      await expect(input).toBeEnabled();
      await gateway.deferNext("users.setDisplayName");
      await input.fill("Keyboard Draft");
      await input.press("Enter");
      const first = await gateway.waitForRequest("users.setDisplayName");
      expect(first.params).toEqual({ profileId: testProfile.id, displayName: "Keyboard Draft" });
      await expect(save).toBeDisabled();
      await page.keyboard.press("Enter");
      expect(await gateway.getRequests("users.setDisplayName")).toHaveLength(1);

      await gateway.rejectDeferred("users.setDisplayName", {
        message: "Synthetic profile name save rejected",
      });
      await expect(page.locator(".identity-error")).toContainText(
        "Synthetic profile name save rejected",
      );
      await expect(save).toBeEnabled();
      await expect(input).toHaveValue("Keyboard Draft");
      await screenshot(page, "display-name-rejected.png");
      await expect(input).toBeFocused();

      await page.keyboard.press("End");
      await page.keyboard.type(" retry");
      await expect(input).toHaveValue("Keyboard Draft retry");
      await gateway.deferNext("users.setDisplayName");
      await page.keyboard.press("Enter");
      const retry = await gateway.waitForRequest("users.setDisplayName", { after: 1 });
      expect(retry.params).toEqual({
        profileId: testProfile.id,
        displayName: "Keyboard Draft retry",
      });
      const profile = { ...testProfile, displayName: "Keyboard Draft retry" };
      await gateway.setMethodResponse("users.self", { profile });
      await gateway.resolveDeferred("users.setDisplayName", { profile });
      await expect(save).toHaveText("Save");
      await expect(input).toHaveValue(profile.displayName);
      await expect(save).toBeDisabled();
      expect(await gateway.getRequests("users.setDisplayName")).toHaveLength(2);
    });
  });

  it("shows the personal connection context without exposing credential fields", async () => {
    await suite.withPage(undefined, async ({ page }) => {
      await openProfilePage(page);
      const section = page.locator("section.settings-section", {
        has: page.locator(".profile-auth-link-input"),
      });
      const row = (title: string) =>
        section.locator(".settings-row").filter({
          has: page.locator(".settings-row__title", { hasText: new RegExp(`^${title}$`, "u") }),
        });
      await expect(row("Gateway")).toContainText(new URL(suite.server.baseUrl).host);
      await expect(row("Person")).toContainText(testProfile.displayName);
      await expect(row("Scope")).toContainText("Personal");
      await expect(section.getByRole("heading", { name: "Connected accounts" })).toBeVisible();
      await expect(section.locator('input[type="password"]')).toHaveCount(0);
    });
  });

  it("shares one authenticated avatar between the sidebar and profile preview", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 800 } }, async ({ page }) => {
      const el = (selector: string) => page.locator(selector);

      await page.route(new URL(profilePath, suite.server.baseUrl).href, (route) =>
        fulfillWithControlUiCsp(route),
      );
      const gatewayUrl = suite.server.baseUrl.replace(/^http/u, "ws").replace(/\/$/u, "");
      await page.addInitScript((sameOriginGatewayUrl) => {
        (
          window as Window & {
            ["__OPENCLAW_NATIVE_CONTROL_AUTH__"]?: { gatewayUrl: string; token: string };
          }
        )["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = {
          gatewayUrl: sameOriginGatewayUrl,
          token: "test",
        };
      }, gatewayUrl);
      const avatarRequests: Array<{ authorization?: string; url: string }> = [];
      await page.route(`**/api/users/${testProfile.id}/avatar*`, async (route) => {
        avatarRequests.push({
          authorization: route.request().headers().authorization,
          url: route.request().url(),
        });
        await route.fulfill({ body: avatarPng, contentType: "image/png", status: 200 });
      });
      await installMockGateway(page, {
        basePath,
        presenceUsers: testPresenceUsers,
        methodResponses: {
          "users.self": { profile: testProfile },
        },
      });

      const response = await page.goto(new URL(profilePath, suite.server.baseUrl).href);
      expect(response?.status()).toBe(200);
      expect(response?.headers()["content-security-policy"]).toContain(
        "img-src 'self' data: blob:",
      );

      const profileAvatar = el("#settings-profile-identity openclaw-viewer-avatar img");
      await profileAvatar.waitFor({ timeout: 10_000 });
      const imageUrl = await profileAvatar.getAttribute("src");
      expect(imageUrl).toMatch(/^blob:/u);
      await expect
        .poll(() => profileAvatar.evaluate((image) => (image as HTMLImageElement).naturalWidth))
        .toBe(1);
      expect(
        await profileAvatar.evaluate((image) =>
          image.closest(".viewer-avatar")?.classList.contains("is-fallback"),
        ),
      ).toBe(false);

      await page.getByRole("button", { name: "Back to app" }).click();
      const sidebarAvatar = el(".sidebar-identity-card openclaw-viewer-avatar img");
      await sidebarAvatar.waitFor({ timeout: 10_000 });
      await expect.poll(() => avatarRequests.length).toBe(1);
      expect(avatarRequests[0]).toEqual({
        authorization: "Bearer e2e-device-token",
        url: new URL(`${basePath}/api/users/${testProfile.id}/avatar?v=2`, suite.server.baseUrl)
          .href,
      });
      expect(await sidebarAvatar.getAttribute("src")).toBe(imageUrl);
      expect(
        await sidebarAvatar.evaluate((image) =>
          image.closest(".viewer-avatar")?.classList.contains("is-fallback"),
        ),
      ).toBe(false);
    });
  });

  it("uploads an avatar through the keyboard-accessible chooser", async () => {
    await suite.withPage(undefined, async ({ page }) => {
      const revision = "uploaded-content-hash-png";
      const gateway = await installMockGateway(page, {
        basePath,
        presenceUsers: testPresenceUsers,
        deferredMethods: ["users.setAvatar"],
        methodResponses: { "users.self": { profile: testProfile } },
      });
      await page.goto(new URL(profilePath, suite.server.baseUrl).href);
      const chooser = page.locator(".identity-avatar-control > button");
      await expect(chooser).toHaveAccessibleName("Choose image");
      await expect(chooser).toBeEnabled();
      await chooser.focus();
      await expect(chooser).toBeFocused();
      const [fileChooser] = await Promise.all([
        page.waitForEvent("filechooser"),
        chooser.press("Enter"),
      ]);
      await fileChooser.setFiles({ name: "avatar.png", mimeType: "image/png", buffer: avatarPng });
      const request = await gateway.waitForRequest("users.setAvatar");
      expect(request.params).toMatchObject({ profileId: testProfile.id, mime: "image/png" });
      await expect(chooser).toBeDisabled();
      await expect
        .poll(() => chooser.evaluate((element) => getComputedStyle(element).opacity))
        .toBe("0.5");
      await gateway.resolveDeferred("users.setAvatar", {
        profile: { ...testProfile, avatarMime: "image/png", hasAvatar: true },
        avatarRevision: revision,
      });
      await expect(chooser).toBeEnabled();
    });
  });
  it("links and disconnects Discord below linked emails without changing GitHub identity", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const account = { accountId: "team", available: true, senderIds: [] as string[] };
      const gateway = await openProfilePage(page, {
        "users.channelIdentity": { status: "ready", accounts: [account] },
      });
      const rows = page.locator("#settings-profile-identity .settings-row");
      const discord = rows.filter({
        has: page.locator(".settings-row__title", { hasText: "Discord account" }),
      });
      await expect(discord.getByRole("button", { name: "Connect Discord" })).toBeEnabled();
      const titles = await rows.locator(".settings-row__title").allTextContents();
      expect(titles.indexOf("Discord account")).toBe(titles.indexOf("Linked emails") + 1);
      expect(titles.indexOf("GitHub account")).toBe(titles.indexOf("Discord account") + 1);
      await screenshot(page, "20-discord-disconnected.png");
      await page.context().route("https://discord.example/**", (route) =>
        route.fulfill({
          body: "Synthetic Discord consent — no live OAuth",
          contentType: "text/plain",
        }),
      );
      const afterStart = await gateway.deferNext("users.channelIdentity", { action: "start" });
      await discord.getByRole("button", { name: "Connect Discord" }).click();
      await gateway.waitForRequest("users.channelIdentity", {
        match: { action: "start" },
        after: afterStart,
      });
      await gateway.setMethodResponse("users.channelIdentity", {
        status: "linked",
        accounts: [{ ...account, senderIds: ["123456789012345678"] }],
      });
      await gateway.resolveDeferred("users.channelIdentity", {
        status: "pending",
        requestId: "test-request",
        authorizationUrl: "https://discord.example/consent",
      });
      await expect(discord).toContainText("Verified");
      await expect(discord).toContainText("123456789012345678");
      await screenshot(page, "21-discord-linked.png");
      await gateway.setMethodResponse("users.channelIdentity", {
        status: "ready",
        accounts: [account],
      });
      await discord.getByRole("button", { name: "Disconnect", exact: true }).click();
      await expect(discord.getByRole("button", { name: "Connect Discord" })).toBeEnabled();
      const afterError = await gateway.deferNext("users.channelIdentity", { action: "start" });
      await discord.getByRole("button", { name: "Connect Discord" }).click();
      await gateway.waitForRequest("users.channelIdentity", {
        match: { action: "start" },
        after: afterError,
      });
      await gateway.rejectDeferred("users.channelIdentity", {
        code: "INVALID_REQUEST",
        message: "Discord sign-in is unavailable. Try again.",
      });
      await expect(discord.getByRole("alert")).toContainText("Try again");
      await screenshot(page, "22-discord-error.png");
      expect(
        await page.locator("body").evaluate((element) => element.scrollWidth),
      ).toBeLessThanOrEqual(1280);
    });
  });
});
