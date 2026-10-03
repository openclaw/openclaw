// Account-menu logout uses authenticated bootstrap metadata, not connected-account actions.
import path from "node:path";
import { expect, type Page } from "playwright/test";
import { beforeEach, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  createControlUiMockBootstrapConfig,
  installMockGateway,
  type ControlUiMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Account menu Cloudflare logout",
  startServerBeforeBrowser: true,
});
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("profile-logout");
  }
});
const basePath = "/wilfred";
const chatPath = `${basePath}/chat`;
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
  { self: true, id: testProfile.id, name: testProfile.displayName, email: testProfile.emails[0] },
];

suite.define(() => {
  async function openChatPage(
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
    const response = await page.goto(new URL(chatPath, suite.server.baseUrl).href);
    expect(response?.status()).toBe(200);
    return gateway;
  }

  async function openIdentityMenu(page: Page) {
    const sidebar = page.locator("openclaw-app-sidebar");
    await sidebar.locator(".sidebar-identity-card").click();
    const menu = sidebar.locator(".sidebar-identity-menu");
    await expect(menu).toBeVisible();
    return menu;
  }

  it("logs out through Cloudflare outside the UI base path without disconnecting linked accounts", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 1000 } }, async ({ page }) => {
      await openChatPage(page);
      await page.route("**/control-ui-config.json", async (route) => {
        await route.fulfill({
          json: {
            ...createControlUiMockBootstrapConfig({ basePath }),
            logout: { provider: "cloudflare-access", path: "/cdn-cgi/access/logout" },
          },
        });
      });
      await page.reload();
      const menu = await openIdentityMenu(page);
      const logout = menu.locator('wa-dropdown-item[value="command:logout"]');
      await expect(logout).toBeVisible();
      await expect(logout).toContainText("Log out");
      if (captureUiProof) {
        await page.screenshot({
          path: path.join(proofDir, "profile-logout-after.png"),
          animations: "disabled",
        });
      }
      await logout.click();
      const confirmation = page.getByRole("dialog", { name: "Log out of Cloudflare Access?" });
      await expect(confirmation).toHaveAttribute(
        "aria-description",
        "This signs you out of Cloudflare Access across all protected applications. Your GitHub sign-in and connected OpenClaw accounts stay unchanged.",
      );
      if (captureUiProof) {
        await page.screenshot({
          path: path.join(proofDir, "profile-logout-confirmation.png"),
          animations: "disabled",
        });
      }
      await page.evaluate(() => {
        window.addEventListener(
          "beforeunload",
          () => {
            const mock = (window as Window & { openclawControlUiE2eGateway?: ControlUiMockGateway })
              .openclawControlUiE2eGateway;
            if (!mock) {
              throw new Error("mock Gateway is unavailable during logout");
            }
            sessionStorage.setItem(
              "logout-proof-methods",
              JSON.stringify(mock.requests.map((request) => request.method)),
            );
          },
          { once: true },
        );
      });
      await page.route("**/cdn-cgi/access/logout", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<h1>Cloudflare Access logout</h1>",
        });
      });
      await page.getByRole("button", { name: "Log out everywhere", exact: true }).click();
      await expect(page).toHaveURL(new URL("/cdn-cgi/access/logout", suite.server.baseUrl).href);
      const methodsAtLogout: string[] = await page.evaluate(() =>
        JSON.parse(sessionStorage.getItem("logout-proof-methods") ?? "[]"),
      );
      expect(methodsAtLogout).toContain("connect");
      expect(methodsAtLogout.some((method) => /disconnect|logout|revoke/iu.test(method))).toBe(
        false,
      );
    });
  });

  it("does not show logout without an authenticated ingress capability", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 1000 } }, async ({ page }) => {
      await openChatPage(page);
      const menu = await openIdentityMenu(page);
      await expect(menu.locator('wa-dropdown-item[value="command:logout"]')).toHaveCount(0);
      if (captureUiProof) {
        await page.screenshot({
          path: path.join(proofDir, "profile-logout-before.png"),
          animations: "disabled",
        });
      }
    });
  });
});
