import { expect, type Locator, type Page } from "playwright/test";
import { it } from "vitest";
import {
  GIT_COAUTHOR_PREFERENCE_KEY,
  type UserModelAccount,
} from "../../../packages/gateway-protocol/src/index.ts";
import {
  buildControlUiCspHeader,
  computeInlineScriptHashes,
} from "../../../src/gateway/control-ui-csp.ts";
import {
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI profile page mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const basePath = "/wilfred";
const profilePath = `${basePath}/settings/profile`;
const avatarPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a6kAAAAASUVORK5CYII=",
  "base64",
);

const profileContext = () => ({ viewport: { width: 1280, height: 800 } });

const imageWidth = (image: Locator) =>
  image.evaluate((element) => (element as HTMLImageElement).naturalWidth);
const avatarState = (image: Locator, state: string) =>
  image.evaluate(
    (element, value) => element.closest(".viewer-avatar")?.classList.contains(value),
    state,
  );

function avatarPresence(
  instanceId: string | undefined,
  revision: string | number,
  name = testProfile.displayName,
) {
  const user = {
    id: testProfile.id,
    name,
    email: testProfile.emails[0],
    avatarUrl: `/api/users/${testProfile.id}/avatar?v=${revision}`,
  };
  return {
    presence: [{ instanceId, mode: "webchat", reason: "connect", user, watchedSessions: [] }],
  };
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
function modelAccount(
  authProfileId: string,
  label: string,
  overrides: Partial<UserModelAccount> = {},
): UserModelAccount {
  return {
    authProfileId,
    label,
    provider: "openai",
    authType: "oauth",
    selected: true,
    ...overrides,
  };
}

const githubAvatarUrl = "https://avatars.githubusercontent.com/u/583231?v=4";
const linkedGitHubProfile = {
  ...testProfile,
  githubIdentity: {
    login: "octocat",
    profileUrl: "https://github.com/octocat",
    avatarUrl: githubAvatarUrl,
  },
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

function installProfileGateway(page: Page, scenario: Partial<ControlUiMockGatewayScenario> = {}) {
  return installMockGateway(page, {
    basePath,
    presenceUsers: testPresenceUsers,
    methodResponses: { "users.self": { profile: testProfile } },
    ...scenario,
  });
}

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
        testPresenceUsers.map((user) =>
          Object.assign({}, user, { name: undefined, email: longEmail }),
        ),
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
      await suite.withPage(profileContext(), async ({ page }) => {
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

        await gateway.setMethodResponse("users.self", { profile });
        const readsBeforeRefresh = (await gateway.getRequests("users.self")).length;
        await page.locator(".profile-refresh").click();
        await gateway.waitForRequest("users.self", { after: readsBeforeRefresh });
        const prefGet = await gateway.waitForRequest("users.prefs.get");
        expect(prefGet.params).toEqual({ keys: [GIT_COAUTHOR_PREFERENCE_KEY] });
        const account = githubRow.getByRole("link", { name: "@octocat" });
        await expect(account).toBeVisible();
        await expect(account).toHaveAttribute("href", profile.githubIdentity.profileUrl);
        await expect(account).toHaveAttribute("target", "_blank");
        await account.focus();
        await expect(account).toBeFocused();
        const avatar = account.locator("img");
        await expect(avatar).toBeVisible();
        await expect(avatar).toHaveAttribute("src", avatarUrl);
        await expect.poll(() => imageWidth(avatar)).toBe(64);
        expect(avatarRequests).toEqual([avatarUrl]);
        await expect(githubRow).toContainText("Verified from your GitHub-backed sign-in");
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
      });
    },
  );

  it.each([
    ["verified GitHub identity", linkedGitHubProfile],
    [
      "merged enterprise hosts without a display primary",
      {
        ...testProfile,
        emails: ["github:ghe.example.test:101", "github:code.example.test:101"],
        githubIdentity: null,
      },
    ],
  ] as const)("keeps default co-author consent editable for %s", async (_name, profile) => {
    await suite.withPage({ viewport: { width: 1280, height: 800 } }, async ({ page }) => {
      const gateway = await openProfilePage(page, {
        "users.self": { profile },
        "users.prefs.get": { status: "ok", entries: {} },
        "users.prefs.set": { status: "ok" },
      });
      const toggle = page
        .locator("#settings-profile-identity")
        .getByRole("switch", { name: "Git co-author credit" });
      await expect(toggle).toBeEnabled();
      await expect(toggle).toBeChecked();
      await toggle.click();
      const saved = await gateway.waitForRequest("users.prefs.set");
      expect(saved.params).toEqual({ entries: { [GIT_COAUTHOR_PREFERENCE_KEY]: false } });
      await expect(toggle).not.toBeChecked();
    });
  });

  it("renders the protected assistant avatar through an authenticated blob fetch", async () => {
    await suite.withPage(profileContext(), async ({ page }) => {
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
      await expect(image).toHaveAttribute("src", /^blob:/u);
      await expect.poll(() => imageWidth(image)).toBe(64);
      expect(avatarRequests.length).toBeGreaterThan(0);
      for (const request of avatarRequests) {
        expect(request).toEqual({
          authorization: "Bearer e2e-device-token",
          resourceType: "fetch",
          url: avatarUrl,
        });
      }
    });
  });

  it("shares one authenticated avatar between the sidebar and profile preview", async () => {
    await suite.withPage(profileContext(), async ({ page }) => {
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
      const expectAvatarRequest = (index: number, revision: number) =>
        expect(avatarRequests[index]).toEqual({
          authorization: "Bearer e2e-device-token",
          url: new URL(
            `${basePath}/api/users/${testProfile.id}/avatar?v=${revision}`,
            suite.server.baseUrl,
          ).href,
        });
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
      const gateway = await installProfileGateway(page);

      const response = await page.goto(new URL(profilePath, suite.server.baseUrl).href);
      expect(response?.status()).toBe(200);
      expect(response?.headers()["content-security-policy"]).toContain(
        "img-src 'self' data: blob:",
      );

      const profileAvatar = page.locator("#settings-profile-identity openclaw-viewer-avatar img");
      await profileAvatar.waitFor({ timeout: 10_000 });
      const imageUrl = await profileAvatar.getAttribute("src");
      expect(imageUrl).toMatch(/^blob:/u);
      await expect.poll(() => imageWidth(profileAvatar)).toBe(1);
      expect(await avatarState(profileAvatar, "is-fallback")).toBe(false);

      await page.getByRole("button", { name: "Back to app" }).click();
      const sidebarAvatar = page.locator(".sidebar-identity-card openclaw-viewer-avatar img");
      await sidebarAvatar.waitFor({ timeout: 10_000 });
      await expect.poll(() => avatarRequests.length).toBe(1);
      expectAvatarRequest(0, 2);
      expect(await sidebarAvatar.getAttribute("src")).toBe(imageUrl);
      expect(await avatarState(sidebarAvatar, "is-fallback")).toBe(false);

      const originalSidebarImage = await sidebarAvatar.elementHandle();
      expect(originalSidebarImage).not.toBeNull();
      const connect = await gateway.waitForRequest("connect");
      const selfInstanceId = (connect.params as { client?: { instanceId?: string } } | undefined)
        ?.client?.instanceId;
      expect(selfInstanceId).toBeTruthy();
      const updatedDisplayName = "Updated Person";
      const publishAvatarRevision = async (revision: number) => {
        await gateway.emitGatewayEvent(
          "presence",
          avatarPresence(selfInstanceId, revision, updatedDisplayName),
        );
      };

      await publishAvatarRevision(3);
      await expect.poll(() => avatarRequests.length).toBe(2);
      await expect(page.locator(".sidebar-identity-card__name")).toHaveText(updatedDisplayName);
      expect(
        await originalSidebarImage?.evaluate((image) =>
          image.closest(".viewer-avatar")?.classList.contains("is-pending"),
        ),
      ).toBe(true);
      expect(await originalSidebarImage?.evaluate((image) => image.isConnected)).toBe(true);

      releaseRevisedAvatar?.();
      await expect.poll(() => imageWidth(sidebarAvatar)).toBe(1);
      const revisedImageUrl = await sidebarAvatar.getAttribute("src");
      expect(revisedImageUrl).toMatch(/^blob:/u);
      expect(revisedImageUrl).not.toBe(imageUrl);
      expect(await originalSidebarImage?.evaluate((image) => image.getAttribute("src"))).toBe(
        revisedImageUrl,
      );
      expect(await avatarState(sidebarAvatar, "is-fallback")).toBe(false);
      expectAvatarRequest(1, 3);

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
          (
            await page.locator(".sidebar-identity-card .viewer-avatar__fallback").textContent()
          )?.trim(),
        )
        .toBe("UP");
      expect(await originalSidebarImage?.evaluate((image) => image.isConnected)).toBe(true);
      expectAvatarRequest(2, 4);
    });
  });

  it("shows personal sign-in context and cancels or completes ChatGPT through recorded gateway status", async () => {
    await suite.withPage(profileContext(), async ({ page }) => {
      const personal = modelAccount("openai:scott", "Test Person · Personal workspace");
      const work = modelAccount("openai:work", "Test Person · Work workspace", { selected: false });
      const connected = modelAccount("openai:personal", "Test Person · New workspace");
      const savedAccounts = [personal, work];
      const inventory = (selected: UserModelAccount | null) => ({
        profileId: testProfile.id,
        accounts: savedAccounts.map((account) => ({
          ...account,
          selected: account.authProfileId === selected?.authProfileId,
        })),
        links: selected
          ? [
              {
                provider: selected.provider,
                authProfileId: selected.authProfileId,
                updatedAt: 1_700_000_000_000,
              },
            ]
          : [],
      });
      const gateway = await openProfilePage(page, {
        "users.listModelAccounts": inventory(personal),
        "users.authConnect.catalog": {
          providers: [
            {
              id: "openai",
              label: "OpenAI",
              methods: [
                { id: "browser", label: "Browser sign-in" },
                { id: "api-key", label: "API key" },
              ],
            },
            { id: "xai", label: "Grok", methods: [{ id: "api-key", label: "API key" }] },
          ],
        },
        "users.authConnect.start": {
          sequence: [1, 2, 3].map((attempt) => ({
            connectId: `connect-${attempt}`,
            expiresAtMs: Date.now() + 60_000,
          })),
        },
        "users.authConnect.status": {
          status: "pending",
          step: {
            id: "redirect",
            type: "text",
            message: "Finish signing in, or paste the redirect URL here.",
            externalUrl: "https://auth.openai.com/oauth/authorize?state=demo-1",
          },
        },
      });
      // Anchor on the always-rendered manual-link row: the Sign in button swaps
      // for the flow UI once clicked, so it cannot identify the section.
      const section = page.locator("section.settings-section", {
        has: page.locator(".profile-auth-link-input"),
      });
      const selectedAccount = section
        .locator(".settings-row")
        .filter({ has: page.locator(".profile-auth-link-unlink") });
      const contextRow = (title: string) =>
        section.locator(".settings-row").filter({
          has: page.locator(".settings-row__title", { hasText: new RegExp(`^${title}$`, "u") }),
        });
      const auth = (name: string) => section.locator(`.profile-auth-${name}`);
      const account = (name: string) => section.locator(`.model-accounts-${name}`);
      const selectedId = selectedAccount.locator(".model-accounts__id");
      const notice = account("notice");
      const startSignIn = async (providerId = "openai") => {
        await section.getByRole("button", { name: "Add account", exact: true }).click();
        const picker = auth("provider");
        await picker.locator(".picker-select__trigger").click();
        await expect(picker.locator('[role="option"][data-value="xai"]')).toBeVisible();
        await picker.locator(`[role="option"][data-value="${providerId}"]`).click();
        if (providerId === "openai") {
          const methods = auth("method");
          await methods.locator(".picker-select__trigger").click();
          await methods.locator('[role="option"][data-value="browser"]').click();
        }
        await expect(auth("connect-start")).toHaveText("Sign in");
        await auth("connect-start").click();
      };

      await expect(contextRow("Gateway")).toContainText(new URL(suite.server.baseUrl).host);
      await expect(contextRow("Person")).toContainText(testProfile.displayName);
      await expect(contextRow("Scope")).toContainText("Personal");
      await expect(section.getByRole("heading", { name: "Connected accounts" })).toBeVisible();
      await expect(section.locator('input[type="password"]')).toHaveCount(0);

      await expect(selectedId.textContent()).resolves.toBe(personal.label);
      await expect(
        selectedAccount.locator(".model-accounts__provider").textContent(),
      ).resolves.toContain("OpenAI");
      await expect(auth("link-unlink").isEnabled()).resolves.toBe(true);

      await startSignIn();
      const openSignIn = section.locator(".wizard-step__external-link");
      await openSignIn.waitFor({ timeout: 10_000 });
      await expect(contextRow("Person")).toContainText(testProfile.displayName);
      await expect(openSignIn.getAttribute("href")).resolves.toBe(
        "https://auth.openai.com/oauth/authorize?state=demo-1",
      );
      await expect(section.locator("#profile-account-auth-answer")).toBeVisible();
      await expect(section.locator(".wizard-step__message")).toHaveText(
        "Finish signing in, or paste the redirect URL here.",
      );

      await gateway.deferNext("users.authConnect.cancel");
      await auth("connect-cancel").click();
      const cancellation = await gateway.waitForRequest("users.authConnect.cancel");
      expect(cancellation.params).toEqual({ profileId: testProfile.id, connectId: "connect-1" });
      await expect(account("flow")).toBeVisible();
      await expect(auth("connect-cancel")).toBeDisabled();
      await gateway.resolveDeferred("users.authConnect.cancel", { status: "cancelled" });
      await expect(account("flow")).toHaveCount(0);
      await expect(section.locator('[role="status"]')).toContainText("Sign-in cancelled.");
      await expect(selectedId).toHaveText(personal.label);

      await gateway.setMethodResponse("users.authConnect.status", {
        status: "pending",
        step: { id: "saving", type: "progress", executor: "gateway", message: "Saving account…" },
      });
      await startSignIn();
      await expect(section.locator(".wizard-step__progress")).toHaveText("Saving account…");
      const readsBeforeRefresh = (await gateway.getRequests("users.self")).length;
      await page.locator(".profile-refresh").click();
      await gateway.waitForRequest("users.self", { after: readsBeforeRefresh });
      await expect(auth("connect-cancel")).toBeEnabled();
      savedAccounts.push(connected);
      await gateway.setMethodResponse("users.listModelAccounts", inventory(connected));
      await gateway.setMethodResponse("users.authConnect.status", {
        status: "connected",
        authProfileId: "openai:personal",
        links: inventory(connected).links,
      });
      await expect(account("flow")).toHaveCount(0);
      await expect(selectedId).toHaveText(connected.label);
      await expect(section.locator('[role="status"]')).toContainText("Account added.");
      await expect(auth("add-account")).toBeEnabled();
      const polls = await gateway.getRequests("users.authConnect.status");
      expect(polls.at(-1)?.params).toEqual({ profileId: testProfile.id, connectId: "connect-2" });
      await gateway.setMethodResponse("users.selectModelAccount", {
        links: inventory(work).links,
      });
      await gateway.setMethodResponse("users.listModelAccounts", inventory(work));
      await section.locator(`[data-auth-profile-id="${work.authProfileId}"]`).click();
      const selection = await gateway.waitForRequest("users.selectModelAccount");
      expect(selection.params).toEqual({
        profileId: testProfile.id,
        authProfileId: work.authProfileId,
      });
      await expect(selectedId).toHaveText(work.label);
      await expect(notice).toContainText("Existing chats are unchanged.");
      await gateway.setMethodResponse("users.unlinkAuthProfile", { links: [] });
      await gateway.setMethodResponse("users.listModelAccounts", inventory(null));
      await section
        .getByRole("button", {
          name: `Use gateway default: OpenAI · ${work.label}`,
          exact: true,
        })
        .click();
      await expect(selectedAccount).toHaveCount(0);
      await expect(auth("account-select")).toHaveCount(3);
      await expect(notice).toContainText("Saved credentials and existing chats are unchanged.");

      const grok = modelAccount("xai:personal", "Test Person · Grok", {
        provider: "xai",
        authType: "api_key",
      });
      await gateway.setMethodResponse("users.authConnect.status", {
        status: "pending",
        step: {
          id: "api-key",
          type: "text",
          sensitive: true,
          message: "Enter your Grok API key",
        },
      });
      await startSignIn("xai");
      const keyInput = section.locator("#profile-account-auth-answer");
      await expect(keyInput).toHaveAttribute("type", "password");
      await keyInput.fill("synthetic-grok-key");
      await gateway.deferNext("users.authConnect.answer");
      await section.locator('.wizard-step__form button[type="submit"]').click();
      const answer = await gateway.waitForRequest("users.authConnect.answer");
      expect(answer.params).toEqual({
        profileId: testProfile.id,
        connectId: "connect-3",
        stepId: "api-key",
        value: "synthetic-grok-key",
      });
      await expect(keyInput).toHaveValue("");
      await expect(keyInput).toBeDisabled();
      savedAccounts.push(grok);
      await gateway.setMethodResponse("users.listModelAccounts", inventory(grok));
      await gateway.resolveDeferred("users.authConnect.answer", {
        status: "connected",
        authProfileId: grok.authProfileId,
        links: inventory(grok).links,
      });
      await expect(selectedId).toHaveText(grok.label);
      await expect(section.locator('input[type="password"]')).toHaveCount(0);
      await expect(notice).toHaveText("Account added.");
    });
  });

  it("keeps identity refresh single-flight and retries after a failed request", async () => {
    await suite.withPage(profileContext(), async ({ page }) => {
      const gateway = await installProfileGateway(page, { deferredMethods: ["users.self"] });

      const response = await page.goto(new URL(profilePath, suite.server.baseUrl).href);
      expect(response?.status()).toBe(200);

      const refresh = page.locator(".profile-refresh");
      const expectRefresh = async (busy: boolean) => {
        if (busy) {
          await expect(refresh).toBeDisabled();
        } else {
          await expect(refresh).toBeEnabled();
        }
        expect(await refresh.ariaSnapshot()).toContain(
          busy ? 'button "Refreshing…" [disabled]' : 'button "Refresh"',
        );
      };
      await gateway.waitForRequest("users.self");
      await expect.poll(async () => (await gateway.getRequests("users.self")).length).toBe(1);
      await expectRefresh(true);

      await refresh.evaluate((element) => {
        const button = element as HTMLButtonElement;
        button.click();
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await expect.poll(async () => (await gateway.getRequests("users.self")).length).toBe(1);

      await gateway.rejectDeferred("users.self", {
        message: "identity unavailable: OPENAI_API_KEY=sk-1234567890abcdef",
      });
      await page
        .getByText("identity unavailable: OPENAI_API_KEY=sk-123...cdef", { exact: true })
        .waitFor({ timeout: 10_000 });
      await expect(page.getByText("sk-1234567890abcdef").count()).resolves.toBe(0);
      await expectRefresh(false);

      await gateway.deferNext("users.self");
      await refresh.click();
      await expect.poll(async () => (await gateway.getRequests("users.self")).length).toBe(2);
      await expectRefresh(true);

      await refresh.evaluate((element) => {
        (element as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await expect.poll(async () => (await gateway.getRequests("users.self")).length).toBe(2);

      await gateway.resolveDeferred("users.self", { profile: testProfile });
      const displayName = page.locator('.identity-name-control input[type="text"]');
      await displayName.waitFor({ timeout: 10_000 });
      await expect(displayName.inputValue()).resolves.toBe(testProfile.displayName);
      await expectRefresh(false);
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
      const gateway = await installProfileGateway(page, { deferredMethods: ["users.setAvatar"] });
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
        await expect(chooser).toBeDisabled();
        await expect
          .poll(() => chooser.evaluate((element) => getComputedStyle(element).opacity))
          .toBe("0.5");
        await gateway.emitGatewayEvent("presence", avatarPresence(selfInstanceId, revision));
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
