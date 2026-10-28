import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { ownerRoster, sessionPerson } from "./session-ownership-fixtures.test-support.ts";
import { chooseSidebarOwner, closeSidebarMenu } from "./sidebar-session-menu.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Guest sidebar owner default" });

suite.define(() => {
  it("starts a guest on Involving me and keeps their later owner choice", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 800 } }, async ({ page }) => {
      const sam = sessionPerson("profile-sam", "Sam");
      const josh = sessionPerson("profile-josh", "Josh");
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
        ...ownerRoster(sessions, [sam, josh]),
        hasMore: false,
        nextOffset: null,
      });
      const gateway = await installMockGateway(page, {
        sessionKey: welcome.key,
        // The restricted role shape Visitor Access requires for invited guests.
        operatorScopes: ["operator.sessions.write"],
        operatorSessionCap: "view",
        presenceUsers: [{ self: true, id: sam.id, name: sam.label }],
        historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Welcome." }] }],
        methodResponses: {
          "sessions.list": {
            cases: [
              { match: { involvingMe: true }, response: list([welcome]) },
              { match: { ownerId: sam.id }, response: list([welcome]) },
              { response: list([welcome, team]) },
            ],
          },
        },
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, welcome.key));
      const owner = page.locator("#sidebar-session-owner-title");
      await expectBrowser(owner).toHaveAccessibleName("Owners: Involving me");
      await gateway.waitForRequest("sessions.list", { match: { involvingMe: true } });

      await chooseSidebarOwner(page, `owner:${sam.id}`);
      await closeSidebarMenu(page);
      await expectBrowser(owner).toHaveAccessibleName("Owners: My sessions");
      await page.reload();
      await expectBrowser(owner).toHaveAccessibleName("Owners: My sessions");
      const [storageKey, ...otherKeys] = await page.evaluate(() =>
        Object.keys(localStorage).filter((key) =>
          key.startsWith("openclaw.control.sidebarSessionOwnerFilter.v1:"),
        ),
      );
      expect(otherKeys).toEqual([]);
      if (!storageKey) {
        throw new Error("expected the guest's saved owner filter");
      }
      expect(await page.evaluate((key) => localStorage.getItem(key), storageKey)).toBe(
        `owner:${sam.id}`,
      );

      // Choices saved in the existing storage format keep winning over the guest default.
      for (const [saved, label] of [
        ["all", "All owners"],
        [`owner:${josh.id}`, josh.label],
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
