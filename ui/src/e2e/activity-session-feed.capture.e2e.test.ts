import { expect, it } from "vitest";
import {
  controlUiBundledGatewayUrl,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { expectAttribute, expectCount, styles } from "./activity-assertions.test-support.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { readThemedPopupPaint } from "./popup-theme.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Activity feed browser geometry",
  startServerBeforeBrowser: true,
});
const identity = { type: "profile" as const, id: "profile-alice" };
const alice = { id: identity.id, identity, label: "Alice Chen" };

suite.define(() => {
  it("keeps activity filters, attribution and inspector links usable in desktop and mobile layouts", () =>
    suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
      async ({ page }) => {
        const now = new Date();
        now.setHours(12, 0, 0, 0);
        const key = "agent:main:release";
        const sessions = ["release", "automation-one", "automation-two"].map((name, index) =>
          Object.assign(
            {
              key: `agent:main:${name}`,
              kind: "direct",
              label: name,
              displayName: name,
              updatedAt: now.getTime() - index,
              createdActor: { type: "human" as const, ...alice },
            },
            index
              ? { hasAutomation: true, createdVia: "cron" }
              : {
                  hasActiveRun: true,
                  activeRunIds: ["mock run:a/b"],
                  observerDigest: {
                    headline: "Waiting on a fictional mock approval",
                    health: "waiting-on-user",
                    revision: 1,
                    runId: "mock run:a/b",
                    updatedAt: now.getTime(),
                  },
                },
          ),
        );
        const listing = {
          ...chatSessionListResponse(sessions),
          people: [{ ...alice, sessionCount: 3 }],
          peopleSessionCount: 3,
        };
        await page.route("**/plugins/geolocation/lookup?ip=203.0.113.20", (route) =>
          route.fulfill({
            contentType: "application/json",
            json: {
              found: true,
              city: "Vienna",
              region: "Vienna",
              attribution: { text: "IP Geolocation by DB-IP", url: "https://db-ip.com" },
            },
          }),
        );
        await page.addInitScript(
          ({ gatewayUrl }) =>
            localStorage.setItem(
              `openclaw.control.settings.v1:${gatewayUrl}`,
              JSON.stringify({ gatewayUrl, theme: "dash", themeMode: "dark" }),
            ),
          { gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl) },
        );
        await installMockGateway(page, {
          sessionKey: key,
          hasMultipleSessionSharingIdentities: true,
          presenceUsers: [
            {
              ...alice,
              name: alice.label,
              platform: "macOS",
              deviceFamily: "Mac",
              ip: "203.0.113.20",
              watchedSessions: [key],
            },
          ],
          methodResponses: {
            "sessions.list": {
              cases: [
                {
                  match: { involvingProfileId: alice.id },
                  response: { ...listing, involvingProfileId: alice.id },
                },
                { response: listing },
              ],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}activity`);
        await waitForControlUiRoute(page, { pathname: "/activity", routeId: "activity" });
        await expectAttribute(page.locator("html"), "data-theme").toBe("dash");
        const activity = page.locator("openclaw-activity-page");
        const left = (selector: string) =>
          activity.locator(selector).evaluate((element) => element.getBoundingClientRect().left);
        expect(
          Math.abs((await left(".page-subtitle")) - (await left(".activity-mode-tabs"))),
        ).toBeLessThanOrEqual(8);
        const people = activity.locator(".activity-feed__people-trigger");
        await people.click();
        const paint = await readThemedPopupPaint(
          activity.locator(".activity-feed__people-popover:popover-open"),
          "body",
        );
        expect(paint.actual).toEqual(paint.expected);
        await page.keyboard.press("Escape");
        const feed = activity.locator(".activity-feed");
        const group = feed.locator("[data-activity-automation-group]");
        await group.waitFor();
        const liveRow = feed.locator(`[data-activity-session="${key}"]`);
        const inspect = liveRow.locator("xpath=following-sibling::a");
        await liveRow.hover();
        await expect
          .poll(() => inspect.evaluate((element) => getComputedStyle(element).opacity))
          .toBe("1");
        await inspect.focus();
        await expect
          .poll(() => inspect.evaluate((element) => document.activeElement === element))
          .toBe(true);
        expect(await inspect.getAttribute("href")).toBe(
          "/activity?view=run&run=mock%20run%3Aa%2Fb",
        );
        await page.locator('[data-navigation-view="online"]').click();
        await page.locator(`[data-online-user-id="${alice.id}"]`).click();
        await waitForControlUiRoute(page, {
          pathname: `/activity/${alice.id}`,
          routeId: "activity",
        });
        const attribution = activity.locator(".activity-feed__device-attribution");
        await expectCount(attribution.locator("svg")).toBe(1);
        await expect.poll(async () => (await attribution.boundingBox())?.width).toBe(16);
        await activity.locator(".activity-feed__people-clear").click();
        await waitForControlUiRoute(page, { pathname: "/activity", routeId: "activity" });
        await group.waitFor();
        await page.setViewportSize({ height: 844, width: 390 });
        const time = activity.locator(".activity-feed__time-filter");
        const buttonTops = await time
          .locator(".settings-segmented__btn")
          .evaluateAll((buttons) =>
            buttons.map((button) => Math.round(button.getBoundingClientRect().top)),
          );
        expect(new Set(buttonTops)).toHaveLength(1);
        await expect
          .poll(async () => {
            const [timeBox, peopleBox] = await Promise.all([
              time.boundingBox(),
              activity.locator(".activity-feed__people-control").boundingBox(),
            ]);
            return timeBox && peopleBox
              ? Math.abs(timeBox.y - peopleBox.y)
              : Number.POSITIVE_INFINITY;
          })
          .toBeLessThan(2);
        const tops = await group
          .locator(":scope > *")
          .evaluateAll((children) =>
            children.map((child) => Math.round(child.getBoundingClientRect().top)),
          );
        expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(3);
        expect(await styles(feed, ["background-color", "border-top-width"])).toEqual([
          "rgba(0, 0, 0, 0)",
          "0px",
        ]);
      },
    ));
});
