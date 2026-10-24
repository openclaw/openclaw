// Control UI tests cover the settings profile page against a mocked Gateway.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "playwright/test";
import { beforeEach, it } from "vitest";
import {
  buildControlUiCspHeader,
  computeInlineScriptHashes,
} from "../../../src/gateway/control-ui-csp.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
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

  it("renders the protected assistant avatar through an authenticated blob fetch", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 800 } }, async ({ page }) => {
      const avatarRequests: Array<{ authorization?: string; resourceType: string; url: string }> =
        [];
      const avatarUrl = new URL(`${basePath}/avatar/main`, suite.server.baseUrl).href;
      await page.route(`**${basePath}/avatar/main`, async (route) => {
        const authorization = route.request().headers().authorization;
        avatarRequests.push({
          authorization,
          resourceType: route.request().resourceType(),
          url: route.request().url(),
        });
        if (authorization !== "Bearer e2e-device-token") {
          await route.fulfill({ status: 401 });
          return;
        }
        await route.fulfill({
          body: `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="#ef4e2f"/><circle cx="23" cy="27" r="4" fill="white"/><circle cx="41" cy="27" r="4" fill="white"/><path d="M20 42c8 6 16 6 24 0" fill="none" stroke="white" stroke-width="4" stroke-linecap="round"/></svg>`,
          contentType: "image/svg+xml",
          status: 200,
        });
      });
      const gateway = await openProfilePage(
        page,
        {
          "users.self": { __mockError: { code: "FORBIDDEN", message: "No authenticated user" } },
          "agent.identity.get": {
            agentId: "main",
            name: "Main agent",
            avatar: `${basePath}/avatar/main`,
            avatarStatus: "local",
          },
          "agents.list": {
            defaultId: "main",
            agents: [
              {
                id: "main",
                identity: { name: "Main agent", avatarUrl: `${basePath}/avatar/main` },
              },
            ],
          },
        },
        [],
      );

      await gateway.waitForRequest("agent.identity.get");
      const image = page.locator(".profile-hero__avatar .identity-avatar__image");
      await image.waitFor({ timeout: 10_000 });
      await expect.poll(() => image.getAttribute("src")).toMatch(/^blob:/u);
      await expect
        .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
        .toBe(64);
      expect(avatarRequests.length).toBeGreaterThan(0);
      expect(new Set(avatarRequests.map((request) => JSON.stringify(request)))).toEqual(
        new Set([
          JSON.stringify({
            authorization: "Bearer e2e-device-token",
            resourceType: "fetch",
            url: avatarUrl,
          }),
        ]),
      );
    });
  });

  it("shares one authenticated avatar between the sidebar and profile preview", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 800 } }, async ({ page }) => {
      const el = (selector: string) => page.locator(selector);

      await page.route(new URL(profilePath, suite.server.baseUrl).href, async (route) => {
        const response = await route.fetch();
        const body = await response.text();
        await route.fulfill({
          body,
          headers: {
            ...response.headers(),
            "content-security-policy": buildControlUiCspHeader({
              inlineScriptHashes: computeInlineScriptHashes(body),
            }),
          },
          response,
        });
      });
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
      let releaseRevisedAvatar: (() => void) | undefined;
      const revisedAvatarReady = new Promise<void>((resolve) => {
        releaseRevisedAvatar = resolve;
      });
      // Profile images require the same bearer auth as gateway RPCs. One cached
      // blob keeps the sidebar and preview inside the Control UI's image CSP.
      await page.route(`**/api/users/${testProfile.id}/avatar*`, async (route) => {
        const revision = new URL(route.request().url()).searchParams.get("v");
        avatarRequests.push({
          authorization: route.request().headers().authorization,
          url: route.request().url(),
        });
        if (revision === "3") {
          // Hold the real response so Chromium can prove pending fallback and
          // stable image-node identity before the replacement finishes loading.
          await revisedAvatarReady;
        }
        if (revision === "4") {
          await route.fulfill({
            body: JSON.stringify({ ok: false, error: { type: "not_found" } }),
            contentType: "application/json",
            status: 404,
          });
          return;
        }
        await route.fulfill({
          body: avatarPng,
          contentType: "image/png",
          status: 200,
        });
      });
      const gateway = await installMockGateway(page, {
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

      const originalSidebarImage = await sidebarAvatar.elementHandle();
      expect(originalSidebarImage).not.toBeNull();
      const connect = await gateway.waitForRequest("connect");
      const selfInstanceId = (connect.params as { client?: { instanceId?: string } } | undefined)
        ?.client?.instanceId;
      expect(selfInstanceId).toBeTruthy();
      const updatedDisplayName = "Updated Person";
      const publishAvatarRevision = async (revision: number) => {
        await gateway.emitGatewayEvent("presence", {
          presence: [
            {
              instanceId: selfInstanceId,
              mode: "webchat",
              reason: "connect",
              user: {
                id: testProfile.id,
                name: updatedDisplayName,
                email: testProfile.emails[0],
                avatarUrl: `/api/users/${testProfile.id}/avatar?v=${revision}`,
              },
              watchedSessions: [],
            },
          ],
        });
      };

      await publishAvatarRevision(3);
      await expect.poll(() => avatarRequests.length).toBe(2);
      await expect(el(".sidebar-identity-card__name")).toHaveText(updatedDisplayName);
      expect(
        await originalSidebarImage?.evaluate((image) =>
          image.closest(".viewer-avatar")?.classList.contains("is-pending"),
        ),
      ).toBe(true);
      expect(await originalSidebarImage?.evaluate((image) => image.isConnected)).toBe(true);

      releaseRevisedAvatar?.();
      await expect
        .poll(() => sidebarAvatar.evaluate((image) => (image as HTMLImageElement).naturalWidth))
        .toBe(1);
      const revisedImageUrl = await sidebarAvatar.getAttribute("src");
      expect(revisedImageUrl).toMatch(/^blob:/u);
      expect(revisedImageUrl).not.toBe(imageUrl);
      expect(await originalSidebarImage?.evaluate((image) => image.getAttribute("src"))).toBe(
        revisedImageUrl,
      );
      expect(
        await sidebarAvatar.evaluate((image) =>
          image.closest(".viewer-avatar")?.classList.contains("is-fallback"),
        ),
      ).toBe(false);
      expect(avatarRequests[1]).toEqual({
        authorization: "Bearer e2e-device-token",
        url: new URL(`${basePath}/api/users/${testProfile.id}/avatar?v=3`, suite.server.baseUrl)
          .href,
      });

      const missingAvatarResponse = page.waitForResponse(
        (candidateResponse) =>
          candidateResponse.url().includes(`/api/users/${testProfile.id}/avatar?v=4`) &&
          candidateResponse.status() === 404,
      );
      await publishAvatarRevision(4);
      await missingAvatarResponse;
      await expect.poll(() => avatarRequests.length).toBe(3);
      await expect.poll(() => sidebarAvatar.getAttribute("src")).toBeNull();
      await expect
        .poll(() =>
          sidebarAvatar.evaluate((image) =>
            image.closest(".viewer-avatar")?.classList.contains("is-fallback"),
          ),
        )
        .toBe(true);
      await expect
        .poll(async () =>
          (await el(".sidebar-identity-card .viewer-avatar__fallback").textContent())?.trim(),
        )
        .toBe("UP");
      expect(await originalSidebarImage?.evaluate((image) => image.isConnected)).toBe(true);
      expect(avatarRequests[2]).toEqual({
        authorization: "Bearer e2e-device-token",
        url: new URL(`${basePath}/api/users/${testProfile.id}/avatar?v=4`, suite.server.baseUrl)
          .href,
      });
    });
  });

  it("keeps event revisions through same-timestamp avatar responses", async () => {
    await suite.withPage(undefined, async ({ page }) => {
      const avatarRequests: string[] = [];
      await page.route(`**/api/users/${testProfile.id}/avatar*`, async (route) => {
        avatarRequests.push(route.request().url());
        await route.fulfill({
          body: avatarPng,
          contentType: "image/png",
          status: 200,
        });
      });
      const gateway = await installMockGateway(page, {
        basePath,
        deferredMethods: ["users.setAvatar"],
        presenceUsers: testPresenceUsers,
        methodResponses: {
          "users.self": { profile: testProfile },
        },
      });
      const response = await page.goto(new URL(profilePath, suite.server.baseUrl).href);
      expect(response?.status()).toBe(200);
      await page.locator("#settings-profile-identity").waitFor({ timeout: 10_000 });
      const connect = await gateway.waitForRequest("connect");
      const selfInstanceId = (connect.params as { client?: { instanceId?: string } } | undefined)
        ?.client?.instanceId;
      expect(selfInstanceId).toBeTruthy();

      const avatarProfile = {
        ...testProfile,
        avatarMime: "image/png" as const,
        hasAvatar: true,
      };
      const upload = async (revision: string) => {
        const requestCountBefore = (await gateway.getRequests("users.setAvatar")).length;
        const updatedAtRevision = String(avatarProfile.updatedAt);
        const updatedAtRequestCountBefore = avatarRequests.filter(
          (url) => new URL(url).searchParams.get("v") === updatedAtRevision,
        ).length;
        const chooser = page.locator(".identity-avatar-control > button");
        await expect(chooser).toHaveAccessibleName("Choose image");
        await chooser.focus();
        await expect(chooser).toBeFocused();
        await screenshot(page, `11-avatar-keyboard-focus-${revision}.png`);
        const [fileChooser] = await Promise.all([
          page.waitForEvent("filechooser"),
          chooser.press("Enter"),
        ]);
        await fileChooser.setFiles({
          name: "avatar.png",
          mimeType: "image/png",
          buffer: avatarPng,
        });
        await expect
          .poll(async () => (await gateway.getRequests("users.setAvatar")).length)
          .toBe(requestCountBefore + 1);
        await screenshot(page, `12-avatar-action-disabled-${revision}.png`);
        await expect(chooser).toBeDisabled();
        await expect
          .poll(() => chooser.evaluate((element) => getComputedStyle(element).opacity))
          .toBe("0.5");
        await gateway.emitGatewayEvent("presence", {
          presence: [
            {
              instanceId: selfInstanceId,
              mode: "webchat",
              reason: "connect",
              user: {
                id: testProfile.id,
                name: testProfile.displayName,
                email: testProfile.emails[0],
                avatarUrl: `/api/users/${testProfile.id}/avatar?v=${revision}`,
              },
              watchedSessions: [],
            },
          ],
        });
        await gateway.resolveDeferred("users.setAvatar", {
          profile: avatarProfile,
          avatarRevision: revision,
        });
        await expect
          .poll(() => avatarRequests.some((url) => new URL(url).searchParams.get("v") === revision))
          .toBe(true);
        expect(
          avatarRequests.filter((url) => new URL(url).searchParams.get("v") === updatedAtRevision),
        ).toHaveLength(updatedAtRequestCountBefore);
      };

      await upload("first-content-hash-png");
      await gateway.deferNext("users.setAvatar");
      await upload("second-content-hash-png");

      const profileAvatar = page.locator("#settings-profile-identity openclaw-viewer-avatar");
      await expect
        .poll(() =>
          profileAvatar.evaluate(
            (element) =>
              (
                element as HTMLElement & {
                  user?: { avatarUrl?: string };
                }
              ).user?.avatarUrl,
          ),
        )
        .toBe(`/api/users/${testProfile.id}/avatar?v=second-content-hash-png`);
      expect(avatarProfile.updatedAt).toBe(testProfile.updatedAt);
    });
  });
});
