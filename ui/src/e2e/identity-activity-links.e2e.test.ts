import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { sessionRow } from "./chat-flow-fixtures.test-support.ts";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { selectAllSidebarSessions } from "./sidebar-navigation.test-support.ts";

const suite = createChatFlowE2eSuite();
const pageOptions = {
  hasTouch: false,
  locale: "en-US",
  serviceWorkers: "block" as const,
  viewport: { height: 900, width: 1280 },
};
const profile = (id: string) => ({ type: "profile" as const, id });
const person = (id: string, label: string) => ({ identity: profile(id), label });
const presence = (id: string, name: string) => ({ id, identity: profile(id), name });
const actor = (id: string) => ({ type: "human" as const, id, ...person(id, "Ada King") });
const mira = person("profile-mira", "Mira");
const waitForActivity = (page: Page, pathname: string, search = "") =>
  waitForControlUiRoute(page, { pathname, routeId: "activity", search });
const expectVisible = (locator: Locator) => expect.poll(() => locator.isVisible()).toBe(true);
suite.define(() => {
  it("opens identity activity links and preserves pretty URLs through filters and reloads", async () => {
    const now = Date.now();
    const selectedSessionKey = "agent:main:identity-selected";
    const sessionKey = "agent:main:identity-hovered";
    const adaId = "a1b2c3d4-1234-4567-89ab-0123456789ab";
    const adaPath = "/activity/ada-king-a1b2c3d41234";
    const missingId = "a1b2c3d4-1234-4567-89ab-0123456789ac";
    const ada = person(adaId, "Ada King");

    await suite.withPage(pageOptions, async ({ page }) => {
      const absentAvatarRequests: string[] = [];
      page.on("request", (request) => {
        if (new URL(request.url()).pathname === "/api/users/profile-mira/avatar") {
          absentAvatarRequests.push(request.url());
        }
      });
      const sessionList = {
        ...chatSessionListResponse([
          sessionRow(selectedSessionKey, "Selected session", now - 5 * 60_000),
          {
            key: sessionKey,
            kind: "direct",
            label: "Ada's session",
            updatedAt: now - 600_000,
            createdActor: actor(adaId),
            owner: { actor: actor(adaId) },
            participants: [ada, mira],
            participantCount: 2,
          },
        ]),
        people: [
          { ...ada, sessionCount: 1 },
          { ...mira, sessionCount: 1 },
        ],
        peopleSessionCount: 2,
        peopleIncomplete: false,
      };
      const associatedSessions = sessionList.sessions.slice(1);
      await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
        hasMultipleSessionSharingIdentities: true,
        presenceUsers: [
          { ...presence("profile-self", "You"), self: true },
          presence(adaId, "Ada King"),
        ],
        methodResponses: {
          "progressCard.get": { card: null },
          "sessions.list": {
            cases: [
              ...[missingId, missingId.replaceAll("-", "")].map((involvingProfileId) => ({
                match: { involvingProfileId },
                response: { ...sessionList, people: [], sessions: [], count: 0, totalCount: 0 },
              })),
              ...[adaId, adaId.replaceAll("-", ""), "a1b2c3d41234", "profile-mira"].map(
                (involvingProfileId) => ({
                  match: { involvingProfileId },
                  response: {
                    ...sessionList,
                    involvingProfileId:
                      involvingProfileId === "profile-mira" ? "profile-mira" : adaId,
                    sessions: associatedSessions,
                    count: 1,
                    totalCount: 1,
                  },
                }),
              ),
              { response: sessionList },
            ],
          },
        },
        sessionKey: selectedSessionKey,
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, selectedSessionKey));
      const sidebar = page.locator("openclaw-app-sidebar");
      const ownerTitle = sidebar.locator("#sidebar-session-owner-title");
      await expect.poll(() => ownerTitle.getAttribute("aria-label")).toBe("Owners: My sessions");
      await selectAllSidebarSessions(page);
      const row = page.locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`);
      const card = page.locator(".session-progress-hovercard");
      await row.waitFor({ state: "visible" });
      await row.hover();
      await card.waitFor({ state: "visible" });
      const trigger = row.locator("a.sidebar-recent-session__link");
      const identity = card.locator("a.session-hovercard__attribution-name");
      const participant = card.locator("openclaw-viewer-facepile a.person-activity-avatar-link");
      const attribution = card.locator(
        ".session-hovercard__attribution-name, .session-hovercard__attribution-others",
      );
      await expect.poll(() => identity.textContent()).toBe("Ada King");
      expect(await identity.getAttribute("href")).toBe(adaPath);
      await expect
        .poll(async () =>
          (await attribution.allTextContents()).join(" ").replace(/\s+/gu, " ").trim(),
        )
        .toBe("Ada King & 1 other");
      await expect
        .poll(() => participant.locator(".viewer-avatar").getAttribute("aria-label"))
        .toBe("Mira");
      expect(await participant.getAttribute("href")).toBe("/activity/profile-mira");
      expect(await participant.locator("img").count()).toBe(0);
      expect(absentAvatarRequests).toEqual([]);
      await identity.hover();
      expect(
        await identity.evaluate((element) => getComputedStyle(element).textDecorationLine),
      ).toBe("underline");
      await participant.hover();

      // The decorative avatar link stays out of the tab order; the name link is the target.
      await trigger.focus();
      await page.keyboard.press("Tab");
      expect(await identity.evaluate((element) => document.activeElement === element)).toBe(true);
      await identity.click();

      await waitForActivity(page, adaPath);
      await expect.poll(() => card.count()).toBe(0);
      const activityPage = page.locator("openclaw-activity-page");
      const adaIdentity = activityPage.locator(`[data-activity-identity="${adaId}"]`);
      const adaSession = activityPage.locator(`[data-activity-session="${sessionKey}"]`);
      const missingPerson = activityPage.getByText("Person not found", { exact: true });
      await expect.poll(() => adaIdentity.count()).toBe(1);
      await expect.poll(() => adaSession.count()).toBe(1);
      expect(
        await activityPage.locator(`[data-activity-session="${selectedSessionKey}"]`).count(),
      ).toBe(0);
      const selectedRow = sidebar.locator(
        `.sidebar-recent-session[data-session-key="${selectedSessionKey}"]`,
      );
      expect(await selectedRow.count()).toBe(1);

      await page.goBack();
      await expect.poll(() => ownerTitle.getAttribute("aria-label")).toBe("Owners: All owners");
      await row.waitFor({ state: "visible" });
      await row.hover();
      await card.waitFor({ state: "visible" });
      await participant.click();
      await waitForActivity(page, "/activity/profile-mira");
      await expect
        .poll(() => activityPage.locator('[data-activity-identity="profile-mira"]').count())
        .toBe(1);

      await page.goto(new URL(adaPath, suite.server.baseUrl).href);
      await waitForActivity(page, adaPath);
      await expectVisible(adaIdentity);
      await activityPage.getByRole("button", { name: "Last 30 days", exact: true }).click();
      await waitForActivity(page, adaPath, "?time=30d");
      await activityPage.getByRole("searchbox").fill("Ada");
      const filterSearch = "?time=30d&q=Ada";
      await waitForActivity(page, adaPath, filterSearch);
      await page.reload();
      await waitForActivity(page, adaPath, filterSearch);
      await expect.poll(() => activityPage.getByRole("searchbox").inputValue()).toBe("Ada");
      await expectVisible(adaIdentity);
      // An exact missing bookmark must never broaden into another person's shared prefix.
      const missingUrl = new URL(`/activity?person=${missingId}`, suite.server.baseUrl);
      await page.goto(missingUrl.href);
      await expectVisible(missingPerson);
      expect(page.url()).toBe(missingUrl.href);
      await activityPage.getByRole("button", { name: "Last 30 days", exact: true }).click();
      await waitForActivity(page, `/activity/${missingId.replaceAll("-", "")}`, "?time=30d");
      await page.reload();
      await expectVisible(missingPerson);
      expect(await adaIdentity.count()).toBe(0);
    });
  });
});
