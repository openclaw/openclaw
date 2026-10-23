import path from "node:path";
import type { Locator, Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { openChatDetailsPeople } from "./chat-details.test-support.ts";
import {
  captureUiProofEnabled,
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { selectAllSidebarSessions } from "./sidebar-navigation.test-support.ts";

let proofDir: string;
beforeEach(() => {
  if (captureUiProofEnabled) {
    proofDir = createControlUiE2eArtifactDir("identity-activity-links");
  }
});

async function captureProof(page: Page, fileName: string): Promise<void> {
  if (!captureUiProofEnabled) {
    return;
  }
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, fileName),
  });
}

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
function ownedSession(
  key: string,
  id: string,
  label: string,
  now: number,
  participants: ReturnType<typeof person>[],
  minutesAgo: number,
) {
  return {
    createdActor: actor(id),
    createdAt: now - 3 * 60 * 60_000,
    key,
    kind: "direct" as const,
    label,
    displayName: label,
    owner: { actor: actor(id) },
    participants,
    participantCount: participants.length,
    updatedAt: now - minutesAgo * 60_000,
  };
}
const waitForActivity = (page: Page, pathname: string, search = "") =>
  waitForControlUiRoute(page, { pathname, routeId: "activity", search });
const expectVisible = (locator: Locator) => expect.poll(() => locator.isVisible()).toBe(true);
function expectRequest(requests: unknown, params: Record<string, string | number>) {
  expect(requests).toEqual(
    expect.arrayContaining([expect.objectContaining({ params: expect.objectContaining(params) })]),
  );
}

suite.define(() => {
  it("opens identity activity links and preserves pretty URLs through filters and reloads", async () => {
    const now = Date.now();
    const selectedSessionKey = "agent:main:identity-selected";
    const sessionKey = "agent:main:identity-hovered";
    const adaId = "a1b2c3d4-1234-4567-89ab-0123456789ab";
    const adaPath = "/activity/ada-king-a1b2c3d41234";
    const exactAdaPath = "/activity/ada-king-a1b2c3d41234456789ab0123456789ab";
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
          {
            key: selectedSessionKey,
            kind: "direct",
            label: "Selected session",
            updatedAt: now - 5 * 60_000,
          },
          ownedSession(sessionKey, adaId, "Ada's session", now, [ada, mira], 10),
        ]),
        people: [
          { ...ada, sessionCount: 1 },
          { ...mira, sessionCount: 1 },
        ],
        peopleSessionCount: 2,
        peopleIncomplete: false,
      };
      const associatedSessions = sessionList.sessions.slice(1);
      const gateway = await installMockGateway(page, {
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
              {
                match: { involvingProfileId: "a1b2c3d41234", search: "no-matching-sessions" },
                response: {
                  ...sessionList,
                  involvingProfileId: adaId,
                  people: [],
                  sessions: [],
                  count: 0,
                  totalCount: 0,
                },
              },
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

      await captureProof(page, "hovercard-identity-rest.png");
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
      await captureProof(page, "hovercard-identity-link.png");
      await participant.hover();
      await captureProof(page, "hovercard-participant-link.png");

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
      await captureProof(page, "hovercard-identity-activity.png");

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
      await captureProof(page, "hovercard-participant-activity.png");

      await page.goto(new URL(adaPath, suite.server.baseUrl).href);
      await waitForActivity(page, adaPath);
      await expectVisible(adaIdentity);
      expectRequest(await gateway.getRequests("sessions.list"), {
        involvingProfileId: "a1b2c3d41234",
      });

      await activityPage.getByRole("button", { name: "Last 30 days", exact: true }).click();
      await waitForActivity(page, adaPath, "?time=30d");
      await activityPage.getByRole("searchbox").fill("Ada");
      const filterSearch = "?time=30d&q=Ada";
      await waitForActivity(page, adaPath, filterSearch);
      await page.reload();
      await waitForActivity(page, adaPath, filterSearch);
      await expect.poll(() => activityPage.getByRole("searchbox").inputValue()).toBe("Ada");
      await expectVisible(adaIdentity);
      expectRequest(await gateway.getRequests("sessions.list"), {
        involvingProfileId: "a1b2c3d41234",
        search: "Ada",
        activeMinutes: 43200,
      });
      await captureProof(page, "pretty-person-activity-filters.png");

      await activityPage.getByRole("searchbox").fill("no-matching-sessions");
      await expectVisible(activityPage.locator(".activity-feed__empty"));
      await page.reload();
      await expectVisible(activityPage.locator(".activity-feed__empty"));
      await expectVisible(adaIdentity);
      expect(await activityPage.locator(".activity-feed__people-clear").isVisible()).toBe(true);
      expect(new URL(page.url()).pathname).toBe(adaPath);

      const legacyUrl = new URL(`/activity?person=${adaId}&time=30d&q=Ada`, suite.server.baseUrl);
      await page.goto(legacyUrl.href);
      await waitForActivity(page, exactAdaPath, filterSearch);
      await expectVisible(adaSession);
      await activityPage.locator(".activity-feed__people-clear").click();
      await waitForActivity(page, "/activity", filterSearch);
      await expect.poll(() => activityPage.locator("[data-activity-identity]").count()).toBe(0);

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

  it("opens an activity feed from the chat header identities and a peer message author", async () => {
    const now = Date.now();
    const sessionKey = "agent:main:shared-thread";

    await suite.withPage(pageOptions, async ({ page }) => {
      const sessionList = {
        ...chatSessionListResponse([
          ownedSession(sessionKey, "profile-ada", "Shared thread", now, [mira], 1),
        ]),
        people: [
          { ...person("profile-ada", "Ada King"), sessionCount: 1 },
          { ...mira, sessionCount: 1 },
        ],
        peopleSessionCount: 1,
        peopleIncomplete: false,
      };
      const associatedSessions = sessionList.sessions;
      await installMockGateway(page, {
        sessions: associatedSessions,
        featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
        hasMultipleSessionSharingIdentities: true,
        presenceUsers: [
          { ...presence("profile-self", "You"), self: true },
          presence("profile-ada", "Ada King"),
          presence("profile-mira", "Mira"),
        ],
        historyMessages: [
          {
            role: "user",
            content: [{ type: "text", text: "Historical attribution stays display-only." }],
            timestamp: now - 180_000,
            // The same raw ID in a historical row is not profile provenance.
            __openclaw: {
              id: "legacy-ada-message",
              senderId: "profile-ada",
              senderName: "Historical Ada",
            },
          },
          {
            role: "user",
            content: [{ type: "text", text: "Handing this over." }],
            timestamp: now - 120_000,
            __openclaw: {
              id: "ada-message",
              senderId: "profile-ada",
              senderIdentity: profile("profile-ada"),
              senderName: "Ada King",
            },
          },
        ],
        methodResponses: {
          "progressCard.get": { card: null },
          "sessions.list": {
            cases: [
              ...["profile-ada", "profile-mira"].map((involvingProfileId) => ({
                match: { involvingProfileId },
                response: {
                  ...sessionList,
                  involvingProfileId,
                  sessions: associatedSessions,
                  count: 1,
                  totalCount: 1,
                },
              })),
              { response: sessionList },
            ],
          },
        },
        sessionKey,
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));

      const people = await openChatDetailsPeople(page);
      const ownerLink = people.getByRole("link", { name: "Ada King Owner", exact: true });
      await ownerLink.waitFor({ state: "visible" });
      expect(await ownerLink.getAttribute("href")).toBe("/activity/profile-ada");
      const participantLink = people.getByRole("link", { name: "Mira", exact: true });
      expect(await participantLink.getAttribute("href")).toBe("/activity/profile-mira");

      const authorGroup = page.locator(".chat-group.user", { hasText: "Handing this over." });
      const author = authorGroup.locator("a.chat-sender-name");
      await author.waitFor({ state: "visible" });
      await expect.poll(() => author.textContent()).toBe("Ada King");
      expect(await author.getAttribute("href")).toBe("/activity/profile-ada");
      const legacyGroup = page.locator(".chat-group.user", {
        hasText: "Historical attribution stays display-only.",
      });
      await legacyGroup.locator(".chat-sender-name").waitFor({ state: "visible" });
      expect(await legacyGroup.locator(".chat-sender-name").textContent()).toBe("Historical Ada");
      expect(await legacyGroup.locator('a[href*="/activity/"]').count()).toBe(0);
      await captureProof(page, "chat-identity-links.png");

      await participantLink.click();
      await waitForActivity(page, "/activity/profile-mira");
      const miraIdentity = page.locator(
        'openclaw-activity-page [data-activity-identity="profile-mira"]',
      );
      await expect.poll(() => miraIdentity.count()).toBe(1);
      await captureProof(page, "chat-participant-activity.png");

      await page.goBack();
      await author.waitFor({ state: "visible" });
      // The persistent-identity footer takes pointer events only while its group is hovered.
      await authorGroup.hover();
      await author.click();
      await waitForActivity(page, "/activity/profile-ada");
      await captureProof(page, "chat-author-activity.png");
    });
  });
});
