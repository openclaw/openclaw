import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import {
  chatMessage,
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { selectAllSidebarSessions } from "./sidebar-navigation.test-support.ts";
import { chooseSidebarOwner, closeSidebarMenu } from "./sidebar-session-menu.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("keeps person cards independent of Involving me while the sidebar stays filtered", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, colorScheme: "dark" },
      async ({ page }) => {
        const selected = "agent:main:shared-design";
        const personal = "agent:main:release-checklist";
        const actor = {
          type: "human" as const,
          id: "alice",
          label: "Alice",
          identity: { type: "profile" as const, id: "alice" },
        };
        const now = Date.now();
        const session = (key: string, label: string, age: number) => ({
          key,
          label,
          kind: "direct",
          updatedAt: now - age,
          owner: { actor },
        });
        const all = {
          ...chatSessionListResponse([
            session(selected, "Shared design review", 60_000),
            session(personal, "Release checklist", 120_000),
          ]),
          owners: [actor],
        };
        const filtered = { ...all, count: 1, sessions: all.sessions.slice(0, 1) };
        const gateway = await installMockGateway(page, {
          sessionKey: selected,
          sessions: all.sessions,
          hasMultipleSessionSharingIdentities: true,
          presenceUsers: [
            {
              self: true,
              id: "viewer",
              name: "Viewer",
              identity: { type: "profile", id: "viewer" },
            },
            {
              id: "alice",
              name: "Alice",
              identity: actor.identity,
            },
          ],
          historyMessages: [chatMessage("assistant", "Ready for the design review.")],
          methodResponses: {
            "sessions.list": {
              cases: [{ match: { involvingMe: true }, response: filtered }, { response: all }],
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, selected));
        await expectBrowser(page.locator(".agent-chat__composer-combobox textarea")).toBeVisible();
        const sidebar = page.locator("openclaw-app-sidebar");
        const sessionList = sidebar.locator(".sidebar-session-content");
        const personalRow = sessionList.locator(`[data-session-key="${personal}"]`);
        await expectBrowser(personalRow).toHaveCount(0);
        await selectAllSidebarSessions(page);
        await expectBrowser(personalRow).toBeVisible();
        await chooseSidebarOwner(page, "involving-me");
        await closeSidebarMenu(page);
        await expectBrowser(personalRow).toHaveCount(0);
        expect(
          (await gateway.getRequests("sessions.list", { involvingMe: true })).length,
        ).toBeGreaterThan(0);
        await sidebar.locator('[data-navigation-view="online"]').click();
        await page.locator('[data-online-user-id="alice"]').hover();
        const card = page.getByRole("dialog", { name: "Activity for Alice" });
        await expectBrowser(card).toBeVisible();
        await expectBrowser(card.getByRole("link", { name: /Shared design review/ })).toBeVisible();
        const releaseLink = card.getByRole("link", { name: /Release checklist/ });
        await expectBrowser(releaseLink).toBeVisible();
        await releaseLink.click();
        await expect.poll(() => new URL(page.url()).pathname).toContain("release-checklist");
        await sidebar.locator('[data-navigation-view="sessions"]').click();
        await expectBrowser(sidebar.locator("#sidebar-session-owner-title")).toHaveText(
          "Involving me",
        );
        await expectBrowser(sessionList.locator(`[data-session-key="${selected}"]`)).toBeVisible();
        await expectBrowser(personalRow).toHaveCount(0);
      },
    );
  });
});
