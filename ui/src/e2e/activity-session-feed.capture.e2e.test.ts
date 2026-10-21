import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  controlUiBundledGatewayUrl,
  controlUiSessionUrl,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import {
  expectAttribute,
  expectCount,
  expectText,
  styles,
} from "./activity-assertions.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { readThemedPopupPaint } from "./popup-theme.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI session activity feed capture",
  startServerBeforeBrowser: true,
});

const proofPhase = process.env.OPENCLAW_MENU_THEME_PROOF_PHASE;
const person = (id: string, label: string) => ({
  identity: { type: "profile" as const, id },
  label,
});
const actor = (id: string, label: string) => ({ type: "human" as const, id, ...person(id, label) });
const alice = actor("profile-alice", "Alice Chen");
const bob = actor("profile-bob", "Bob Rivera");
const carol = actor("profile-carol", "Carol Singh");
const presence = <T>(id: string, name: string, details: T) => ({
  id,
  identity: { type: "profile" as const, id },
  name,
  ...details,
});

suite.define(() => {
  it("captures online, global activity, and person-filtered activity surfaces", async () => {
    await suite.withPage(
      {
        colorScheme: "light",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const outputDir = createControlUiE2eArtifactDir("session-activity-feed");
        const capture = (name: string, fullPage = false) =>
          page.screenshot({
            animations: "disabled",
            path: path.join(outputDir, name),
            ...(fullPage ? { fullPage } : {}),
          });
        await page.route("**/plugins/geolocation/lookup?ip=203.0.113.20", async (route) => {
          await route.fulfill({
            contentType: "application/json",
            json: {
              found: true,
              city: "Vienna",
              region: "Vienna",
              attribution: { text: "IP Geolocation by DB-IP", url: "https://db-ip.com" },
            },
          });
        });
        const current = new Date();
        const day = (offset: number, hour = 0) =>
          new Date(
            current.getFullYear(),
            current.getMonth(),
            current.getDate() + offset,
            hour,
          ).getTime();
        const since = day(-7);
        const until = day(1);
        // Keep the automation fixtures on one local calendar day in every timezone.
        const now = day(-1, 12);
        const releaseKey = "agent:main:release-readiness";
        const designKey = "agent:main:design-review";
        const gatewayHandoffKey = "agent:main:gateway-handoff";
        const nightlyMaintenanceKey = "agent:main:nightly-maintenance";
        const incidentNotesKey = "agent:main:incident-notes";
        const automationKeys = [designKey, gatewayHandoffKey, nightlyMaintenanceKey];
        const nonAutomationKeys = [releaseKey, incidentNotesKey];
        const session = (
          key: string,
          displayName: string,
          createdActor: typeof alice,
          minutes: number,
        ) => ({
          key,
          displayName,
          kind: "direct",
          agentId: "main",
          createdActor,
          owner: { actor: createdActor },
          updatedAt: now - minutes * 60_000,
        });
        const sessionList = {
          activityPulse: {
            since,
            until,
            buckets: [0, 0, 0, 0, 0, 0, 5, 0],
            sessions: 5,
            started: 0,
            people: 3,
            running: 1,
          },
          peopleIncomplete: true,
          people: [
            { ...person(alice.id, alice.label), sessionCount: 3 },
            { ...person(bob.id, bob.label), sessionCount: 2 },
            { ...person(carol.id, carol.label), sessionCount: 2 },
          ],
          peopleSessionCount: 5,
          count: 5,
          creators: [
            { id: "profile-alice", label: "Alice Chen" },
            { id: "profile-bob", label: "Bob Rivera" },
            { id: "profile-carol", label: "Carol Singh" },
          ],
          defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
          path: "",
          sessions: [
            {
              ...session(releaseKey, "Release readiness", alice, 4),
              channel: "webchat",
              participants: [person(bob.id, bob.label)],
              activeRunIds: ["mock run:a/b"],
              hasActiveRun: true,
              observerDigest: {
                headline: "Waiting on a fictional mock approval",
                health: "waiting-on-user",
                revision: 1,
                runId: "mock run:a/b",
                updatedAt: now - 4 * 60_000,
              },
              status: "running",
            },
            {
              ...session(designKey, "Control UI design review", bob, 42),
              createdVia: "cron",
              participants: [person(alice.id, alice.label)],
              hasAutomation: true,
            },
            {
              ...session(gatewayHandoffKey, "Gateway handoff", carol, 120),
              createdVia: "cron",
              hasAutomation: true,
            },
            {
              ...session(nightlyMaintenanceKey, "Nightly mock maintenance", carol, 180),
              createdVia: "cron",
              hasAutomation: true,
            },
            session(incidentNotesKey, "Incident follow-up", alice, 50 * 60),
          ],
          ts: now,
        };
        const filtered = (keys: string[]) => ({
          ...sessionList,
          count: keys.length,
          sessions: sessionList.sessions.filter((row) => keys.includes(row.key)),
        });
        await installMockGateway(page, {
          hasMultipleSessionSharingIdentities: true,
          presenceUsers: [
            presence("profile-self", "Operator", { self: true }),
            presence(alice.id, alice.label, {
              email: "alice@example.test",
              host: "Alice's MacBook Pro",
              platform: "macOS 26.5",
              deviceFamily: "Mac",
              ip: "203.0.113.20",
              lastInputSeconds: 32,
              watchedSessions: [releaseKey, designKey],
            }),
            presence(bob.id, bob.label, {
              email: "bob@example.test",
              host: "Bob's Mac Studio",
              platform: "macOS 26.5",
              deviceFamily: "Mac",
              lastInputSeconds: 640,
              watchedSessions: [],
            }),
            presence(carol.id, carol.label, {
              lastInputSeconds: 14,
              watchedSessions: [releaseKey],
            }),
            presence("profile-dan", "Dan Wu", {
              lastInputSeconds: 70,
              watchedSessions: [designKey],
            }),
          ],
          methodResponses: {
            "sessions.list": {
              cases: [
                {
                  match: { involvingProfileId: "profile-carol" },
                  response: filtered([gatewayHandoffKey, nightlyMaintenanceKey]),
                },
                {
                  match: { involvingProfileId: "profile-alice" },
                  response: filtered([releaseKey, designKey, incidentNotesKey]),
                },
                { response: sessionList },
              ],
            },
          },
          sessionKey: releaseKey,
        });

        const response = await page.goto(controlUiSessionUrl(suite.server.baseUrl, releaseKey));
        expect(response?.status()).toBe(200);
        const onlineView = page.locator('[data-navigation-view="online"]');
        await onlineView.click();
        await expectAttribute(onlineView, "aria-pressed").toBe("true");
        await expectCount(page.locator(".sidebar-online__person")).toBe(5);
        await page.locator(".sidebar").screenshot({
          animations: "disabled",
          path: path.join(outputDir, "01-sidebar-users-online-light.png"),
        });

        await page.evaluate(
          ({ gatewayUrl }) => {
            localStorage.setItem(
              `openclaw.control.settings.v1:${gatewayUrl}`,
              JSON.stringify({ gatewayUrl, theme: "dash", themeMode: "dark" }),
            );
          },
          { gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl) },
        );
        await page.reload();
        await expectAttribute(page.locator("html"), "data-theme").toBe("dash");

        await evaluateControlUiContext(page, (context) => {
          context.navigate("activity");
        });
        await waitForControlUiRoute(page, { pathname: "/activity", routeId: "activity" });
        const activityPage = page.locator("openclaw-activity-page");
        await expectCount(activityPage).toBe(1);
        await activityPage.locator(".activity-pulse__bars").waitFor();
        expect(await activityPage.locator(".activity-pulse__bars > span").count()).toBe(
          sessionList.activityPulse.buckets.length,
        );
        // The stacked page header's intro copy and the mode tabs share the
        // content's left edge.
        const introLeft = await activityPage
          .locator(".page-subtitle")
          .evaluate((element) => element.getBoundingClientRect().left);
        const tabsLeft = await activityPage
          .locator(".activity-mode-tabs")
          .evaluate((element) => element.getBoundingClientRect().left);
        expect(Math.abs(introLeft - tabsLeft)).toBeLessThanOrEqual(8);
        await activityPage.locator(".activity-feed__people-trigger").click();
        await expectCount(
          activityPage.locator(
            '.activity-feed__people-row[data-activity-person]:not([data-activity-person=""])',
          ),
        ).toBe(3);
        const peoplePopover = activityPage.locator(".activity-feed__people-popover:popover-open");
        const peoplePaint = await readThemedPopupPaint(peoplePopover, "body");
        if (proofPhase) {
          await capture(`05-people-menu-${proofPhase}.png`);
        }
        expect(peoplePaint.actual).toEqual(peoplePaint.expected);
        await page.keyboard.press("Escape");
        const activityFeed = activityPage.locator(".activity-feed");
        const activitySession = (key: string) =>
          activityFeed.locator(`[data-activity-session="${key}"]`);
        const automationGroup = activityFeed.locator("[data-activity-automation-group]");
        await expectCount(automationGroup).toBe(1);
        await expectAttribute(automationGroup, "aria-expanded").toBe("false");
        for (const key of nonAutomationKeys) {
          await expectCount(activitySession(key)).toBe(1);
        }
        for (const key of automationKeys) {
          await expectCount(activitySession(key)).toBe(0);
        }
        await automationGroup.click();
        await expectAttribute(automationGroup, "aria-expanded").toBe("true");
        for (const key of automationKeys) {
          await expectCount(activitySession(key)).toBe(1);
        }
        await automationGroup.click();
        await expectAttribute(automationGroup, "aria-expanded").toBe("false");
        for (const key of automationKeys) {
          await expectCount(activitySession(key)).toBe(0);
        }
        for (const key of nonAutomationKeys) {
          await expectCount(activitySession(key)).toBe(1);
        }

        const liveRow = activitySession(releaseKey);
        await expectCount(liveRow.locator(".activity-feed__run-dot")).toBe(1);
        await expectText(liveRow.locator(".activity-feed__session-headline")).toContain(
          "Waiting on a fictional mock approval",
        );
        const inspectRun = liveRow.locator("xpath=following-sibling::a");
        await liveRow.hover();
        await expect
          .poll(() => inspectRun.evaluate((element) => getComputedStyle(element).opacity))
          .toBe("1");
        await inspectRun.focus();
        await expect
          .poll(() => inspectRun.evaluate((element) => document.activeElement === element))
          .toBe(true);
        expect(await inspectRun.getAttribute("href")).toBe(
          "/activity?view=run&run=mock%20run%3Aa%2Fb",
        );
        const timeFilter = activityPage.locator(".activity-feed__time-filter");
        expect(
          await timeFilter
            .locator(".settings-segmented__btn")
            .evaluateAll((buttons) => buttons.map((button) => button.textContent?.trim())),
        ).toEqual(["Last 24 hours", "Last 7 days", "Last 30 days", "All time"]);
        await capture("05-global-activity.png");

        await onlineView.click();
        await page.locator('[data-online-user-id="profile-alice"]').click();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/activity/profile-alice");
        await expect
          .poll(() => activityPage.locator('[data-activity-identity="profile-alice"]').isVisible())
          .toBe(true);
        const attributionIcon = activityPage.locator(".activity-feed__device-attribution");
        await expectCount(attributionIcon.locator("svg")).toBe(1);
        await expect.poll(async () => (await attributionIcon.boundingBox())?.width).toBe(16);
        await expectCount(
          activityPage.locator(".activity-feed__viewing-list .activity-feed__session"),
        ).toBe(2);
        await capture("06-person-activity.png");

        await activityPage.locator(".activity-feed__people-clear").click();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/activity");
        await activityPage.locator(".activity-feed__people-trigger").click();
        await activityPage.locator('[data-activity-person="profile-carol"]').click();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/activity/profile-carol");
        await expectCount(activitySession(nightlyMaintenanceKey)).toBe(1);
        await expectCount(
          activitySession(nightlyMaintenanceKey).locator('[data-activity-created-via="cron"]'),
        ).toBe(1);
        await capture("06-automation-creator-desktop.png");

        await activityPage.locator(".activity-feed__people-clear").click();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/activity");
        await page.setViewportSize({ height: 844, width: 390 });

        const peopleControl = activityPage.locator(".activity-feed__people-control");
        const timeButtonTops = await timeFilter
          .locator(".settings-segmented__btn")
          .evaluateAll((buttons) =>
            buttons.map((button) => Math.round(button.getBoundingClientRect().top)),
          );
        expect(new Set(timeButtonTops)).toHaveLength(1);
        await expect
          .poll(async () => {
            const [timeFilterBox, peopleControlBox] = await Promise.all([
              timeFilter.boundingBox(),
              peopleControl.boundingBox(),
            ]);
            if (!timeFilterBox || !peopleControlBox) {
              return Number.POSITIVE_INFINITY;
            }
            return Math.abs(timeFilterBox.y - peopleControlBox.y);
          })
          .toBeLessThan(2);
        const automationGroupChildTops = await automationGroup
          .locator(":scope > *")
          .evaluateAll((children) =>
            children.map((child) => Math.round(child.getBoundingClientRect().top)),
          );
        expect(
          Math.max(...automationGroupChildTops) - Math.min(...automationGroupChildTops),
        ).toBeLessThan(3);
        expect(await styles(activityFeed, ["background-color", "border-top-width"])).toEqual([
          "rgba(0, 0, 0, 0)",
          "0px",
        ]);
        await activityPage.locator(".activity-feed__people-trigger").click();
        await activityPage.locator('[data-activity-person="profile-carol"]').click();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/activity/profile-carol");
        await expectCount(activitySession(nightlyMaintenanceKey)).toBe(1);
        await expectCount(activityFeed.locator('[data-activity-created-via="cron"]')).toBe(2);
        await capture("07-automation-creator-mobile.png", true);
      },
    );
  });
});
