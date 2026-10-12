import path from "node:path";
import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  captureUiProofEnabled,
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
        const all = {
          ...chatSessionListResponse([
            {
              key: selected,
              kind: "direct",
              label: "Shared design review",
              updatedAt: now - 60_000,
              owner: { actor },
            },
            {
              key: personal,
              kind: "direct",
              label: "Release checklist",
              updatedAt: now - 120_000,
              owner: { actor },
            },
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
              deviceFamily: "Mac",
              platform: "macOS",
              onlineSince: now - 3_600_000,
              lastActivityAt: now - 600_000,
            },
          ],
          historyMessages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Ready for the design review." }],
            },
          ],
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
        // My sessions belongs to Viewer, not to the people whose cards we inspect.
        await expectBrowser(
          sessionList.locator('[data-session-key="' + personal + '"]'),
        ).toHaveCount(0);
        await selectAllSidebarSessions(page);
        await expectBrowser(
          sessionList.locator('[data-session-key="' + personal + '"]'),
        ).toBeVisible();
        await chooseSidebarOwner(page, "involving-me");
        await closeSidebarMenu(page);
        await expectBrowser(
          sessionList.locator('[data-session-key="' + personal + '"]'),
        ).toHaveCount(0);
        expect(
          (await gateway.getRequests("sessions.list", { involvingMe: true })).length,
        ).toBeGreaterThan(0);
        await sidebar.locator('[data-navigation-view="online"]').click();
        await page.locator('[data-online-user-id="alice"]').hover();
        const card = page.getByRole("dialog", { name: "Activity for Alice" });
        await expectBrowser(card).toBeVisible();
        await expectBrowser(card.getByRole("link", { name: /Shared design review/ })).toBeVisible();
        if (captureUiProofEnabled) {
          const directory = createControlUiE2eArtifactDir("person-card-filters");
          await page.screenshot({
            path: path.join(directory, "involving-me.png"),
            animations: "disabled",
          });
        }
        await expectBrowser(card.getByRole("link", { name: /Release checklist/ })).toBeVisible();
        await card.getByRole("link", { name: /Release checklist/ }).click();
        await expect.poll(() => new URL(page.url()).pathname).toContain("release-checklist");
        expect(
          await sidebar.evaluate(
            (element: HTMLElement & { sessionInvolvingMeFilterActive: boolean }) =>
              element.sessionInvolvingMeFilterActive,
          ),
        ).toBe(true);
        // Online is a separate view. Returning to Sessions must restore the
        // involvement filter, rather than proving absence in an unmounted list.
        await sidebar.locator('[data-navigation-view="sessions"]').click();
        await expectBrowser(
          sessionList.locator('[data-session-key="' + selected + '"]'),
        ).toBeVisible();
        await expectBrowser(
          sessionList.locator('[data-session-key="' + personal + '"]'),
        ).toHaveCount(0);
      },
    );
  });
});
