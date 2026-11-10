import { expectDefined } from "@openclaw/normalization-core";
import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import {
  controlUiBundledGatewayUrl,
  controlUiE2eWaitTimeoutMs,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { ownerRoster, sessionPerson } from "./session-ownership-fixtures.test-support.ts";
import { chooseSidebarOwner, closeSidebarMenu } from "./sidebar-session-menu.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Guest sidebar owner default" });

suite.define(() => {
  it("retires a saved foreign owner before a restricted guest's first personal sidebar request", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 800 } }, async ({ page }) => {
      const sam = sessionPerson("profile-sam", "Sam");
      const josh = sessionPerson("profile-josh", "Josh");
      const privacyMessage =
        "Other people's activity is private. You can still open sessions shared with you.";
      const row = (id: string, label: string, owner: typeof sam, updatedAt: number) => ({
        key: `agent:main:${id}`,
        sessionId: id,
        kind: "direct" as const,
        label,
        owner: { actor: owner },
        updatedAt,
      });
      const welcome = row("welcome-sam", "Welcome, Sam", sam, 3);
      const team = row("release-tracker", "Release tracker", josh, 2);
      const list = (sessions: (typeof welcome)[]) => ({
        ...ownerRoster(sessions, [sam]),
        hasMore: false,
        nextOffset: null,
      });
      const storageKey = `openclaw.control.sidebarSessionOwnerFilter.v1:${controlUiBundledGatewayUrl(suite.server.baseUrl)}:${encodeURIComponent(sam.id)}`;
      // Restore the previous role's choice before the app or its subscriptions mount.
      await page.addInitScript(
        ({ key, value }) => {
          if (localStorage.getItem(key) === null) {
            localStorage.setItem(key, value);
          }
        },
        { key: storageKey, value: `owner:${josh.id}` },
      );
      const gateway = await installMockGateway(page, {
        sessionKey: welcome.key,
        awaitInitialRoster: false,
        hasMultipleSessionSharingIdentities: true,
        // The restricted role shape Visitor Access requires for invited guests.
        operatorScopes: ["operator.sessions.write"],
        operatorSessionCap: "view",
        roleAllowsAdmin: false,
        profileActivityViewerId: sam.id,
        presenceUsers: [{ self: true, id: sam.id, name: sam.label }],
        historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Welcome." }] }],
        methodResponses: {
          "sessions.list": {
            cases: [
              {
                match: { ownerId: josh.id },
                response: {
                  __mockError: {
                    code: "FORBIDDEN",
                    message: privacyMessage,
                  },
                },
              },
              { match: { involvingMe: true }, response: list([welcome]) },
              { match: { ownerId: sam.id }, response: list([welcome]) },
              { response: list([welcome, team]) },
            ],
          },
        },
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, welcome.key));
      // Connection hydration may discover an unfiltered roster before the sidebar mounts.
      // The first personal selection must already belong to the current authenticated role.
      const personalRequests = async () =>
        (
          await gateway.getRequests("sessions.list", { source: "sidebar", rowMode: "sidebar" })
        ).filter((request) => {
          const params = request.params as { ownerId?: string; involvingMe?: boolean };
          return params.ownerId !== undefined || params.involvingMe === true;
        });
      await expect
        .poll(async () => (await personalRequests()).length, {
          timeout: controlUiE2eWaitTimeoutMs,
        })
        .toBeGreaterThan(0);
      const firstSidebarRequest = expectDefined(
        (await personalRequests())[0],
        "Expected a personal sidebar request",
      );
      const sidebar = page.locator("openclaw-app-sidebar");
      if ((firstSidebarRequest.params as { ownerId?: string }).ownerId === josh.id) {
        await expectBrowser(sidebar.locator("[data-sidebar-session-error]")).toContainText(
          privacyMessage,
        );
      }
      expect(firstSidebarRequest.params).toMatchObject({ involvingMe: true });
      expect(firstSidebarRequest.params).not.toHaveProperty("ownerId");
      const owner = page.locator("#sidebar-session-owner-title");
      await expectBrowser(owner).toHaveAccessibleName("Owners: Involving me");
      await expectBrowser(sidebar.locator(`[data-session-key="${welcome.key}"]`)).toBeVisible();
      await expectBrowser(sidebar.locator("[data-sidebar-session-error]")).toHaveCount(0);
      expect(await page.evaluate((key) => localStorage.getItem(key), storageKey)).toBe(
        "involving-me",
      );
      await page.reload();
      await expectBrowser(owner).toHaveAccessibleName("Owners: Involving me");
      await gateway.waitForRequest("sessions.list", { match: { involvingMe: true } });
      await expectBrowser(sidebar.locator(`[data-session-key="${welcome.key}"]`)).toBeVisible();
      await expectBrowser(sidebar.locator("[data-sidebar-session-error]")).toHaveCount(0);

      await chooseSidebarOwner(page, "all");
      await closeSidebarMenu(page);
      await expectBrowser(owner).toHaveCount(0);
      await expectBrowser(sidebar.locator(`[data-session-key="${team.key}"]`)).toBeVisible();
      await expectBrowser(sidebar.locator("[data-sidebar-session-error]")).toHaveCount(0);
      await page.reload();
      await expectBrowser(owner).toHaveCount(0);
      await expectBrowser(sidebar.locator(`[data-session-key="${team.key}"]`)).toBeVisible();
      await expectBrowser(sidebar.locator("[data-sidebar-session-error]")).toHaveCount(0);
      const [savedStorageKey, ...otherKeys] = await page.evaluate(() =>
        Object.keys(localStorage).filter((key) =>
          key.startsWith("openclaw.control.sidebarSessionOwnerFilter.v1:"),
        ),
      );
      expect(otherKeys).toEqual([]);
      expect(savedStorageKey).toBe(storageKey);
      expect(await page.evaluate((key) => localStorage.getItem(key), storageKey)).toBe("all");

      // Admissible saved choices still win over the guest default.
      for (const [saved, label] of [
        [`owner:${sam.id}`, "My sessions"],
        ["involving-me", "Involving me"],
      ] as const) {
        await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
          key: storageKey,
          value: saved,
        });
        await page.reload();
        await expectBrowser(owner).toHaveAccessibleName(`Owners: ${label}`);
      }
    });
  });
});
