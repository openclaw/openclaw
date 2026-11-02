import { expect, it } from "vitest";
import {
  controlUiBundledGatewayUrl,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import {
  expectAttribute,
  expectCount,
  expectText,
  styles,
} from "./activity-assertions.test-support.ts";
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
        await page
          .locator(`[data-online-user-id="${alice.id}"]`)
          .getByText(alice.label, { exact: true })
          .click();
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
            const [searchBox, peopleBox] = await Promise.all([
              activity.locator(".activity-feed__search").boundingBox(),
              activity.locator(".activity-feed__people-control").boundingBox(),
            ]);
            return searchBox && peopleBox
              ? Math.abs(searchBox.y - peopleBox.y)
              : Number.POSITIVE_INFINITY;
          })
          .toBeLessThan(2);
        // The row reads title, one meta line, then Inspect run closing the recap.
        await expectText(liveRow.locator(".activity-feed__session-meta")).toContain("Alice Chen");
        const phoneInspect = feed.locator(
          `[data-activity-recap="${key}"] .activity-feed__inspect-run`,
        );
        expect(await phoneInspect.getAttribute("href")).toBe(
          "/activity?view=run&run=mock%20run%3Aa%2Fb",
        );
        // The person filter is one icon button that reports the active choice on itself.
        await people.click();
        await page.locator(`[data-activity-person="${alice.id}"]`).click();
        await waitForControlUiRoute(page, {
          pathname: `/activity/${alice.id}`,
          routeId: "activity",
        });
        await expect
          .poll(() => people.evaluate((el) => el.classList.contains("active")))
          .toBe(true);
        expect(await activity.locator(".activity-feed__people-clear").count()).toBe(0);
        await people.click();
        await page.locator('[data-activity-person=""]').click();
        await waitForControlUiRoute(page, { pathname: "/activity", routeId: "activity" });
        await group.waitFor();
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

  it("folds Live activity controls into the filter popover and actions menu on phones", () =>
    suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 844, width: 390 } },
      async ({ page }) => {
        const key = "agent:main:release";
        const session = {
          key,
          kind: "direct",
          label: "release",
          displayName: "release",
          updatedAt: Date.now(),
          hasActiveRun: true,
          activeRunIds: ["live-run"],
          status: "running",
        };
        const gateway = await installMockGateway(page, {
          sessionKey: key,
          methodResponses: { "sessions.list": chatSessionListResponse([session]) },
        });
        await page.goto(`${suite.server.baseUrl}activity?view=live`);
        await waitForControlUiRoute(page, { pathname: "/activity", routeId: "activity" });
        const activity = page.locator("openclaw-activity-page");
        await activity.locator(".activity-current-work__row").waitFor();
        for (const [id, isError] of [
          ["call-one", false],
          ["call-two", true],
        ] as const) {
          await gateway.emitGatewayEvent("session.tool", {
            stream: "tool",
            runId: "live-run",
            sessionKey: key,
            data: { toolCallId: id, name: "read", phase: "result", isError, result: { text: id } },
          });
        }
        const entries = activity.locator(".activity-entry");
        await expectCount(entries).toBe(2);

        const trigger = activity.locator("#activity-live-filter-trigger");
        const statuses = activity.locator('.activity-status-filter input[type="checkbox"]');

        await trigger.click();
        const panel = activity.locator(".activity-live-filter-popover:popover-open");
        await expectCount(panel.locator('.activity-status-filter input[type="checkbox"]')).toBe(3);
        await expectCount(panel.locator(".activity-live-autofollow").getByRole("switch")).toBe(1);
        await statuses.nth(1).click();
        await expectCount(entries).toBe(1);
        await expect
          .poll(() => trigger.evaluate((el) => el.classList.contains("active")))
          .toBe(true);
        await statuses.nth(1).click();
        await expectCount(entries).toBe(2);
        await expect
          .poll(() => trigger.evaluate((el) => el.classList.contains("active")))
          .toBe(false);
        await page.keyboard.press("Escape");

        const actions = page.locator(".topnav-shell__page-actions .activity-live-actions__trigger");
        await actions.click();
        await page.getByRole("menuitem", { name: "Expand all" }).click();
        await expect
          .poll(() =>
            entries.evaluateAll((rows) => rows.every((row) => (row as HTMLDetailsElement).open)),
          )
          .toBe(true);
        await actions.click();
        await page.getByRole("menuitem", { name: "Collapse all" }).click();
        await expect
          .poll(() =>
            entries.evaluateAll((rows) => rows.some((row) => (row as HTMLDetailsElement).open)),
          )
          .toBe(false);
        await actions.click();
        await page.getByRole("menuitem", { name: "Clear" }).click();
        await expectCount(entries).toBe(0);
      },
    ));

  it("omits raw actor ids from phone rows while keeping their full identity reachable", () =>
    suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 844, width: 390 } },
      async ({ page }) => {
        const rawId = "147591189530201337";
        const now = Date.now();
        const row = (name: string, age: number, actor: object, activitySummary: object) => ({
          key: `agent:main:${name}`,
          kind: "direct",
          label: name,
          displayName: name,
          agentId: "main",
          updatedAt: now - age,
          createdActor: actor,
          hasActiveRun: true,
          activeRunIds: [`run-${name}`],
          activitySummary,
          observerDigest: {
            headline: "Checking a fictional mock step",
            health: "healthy",
            revision: 1,
            runId: `run-${name}`,
            updatedAt: now - age,
          },
        });
        const recap =
          "Reconciled the fictional timeline and listed the two remaining mock decisions that still need an answer before this handoff can close for the day.";
        const listing = {
          ...chatSessionListResponse([
            row(
              "unresolved",
              60_000,
              { type: "human", id: rawId },
              {
                state: "current",
                canEnsure: true,
                text: recap,
                updatedAt: now,
              },
            ),
            row(
              "named",
              120_000,
              { type: "human", ...alice },
              {
                state: "updating",
                canEnsure: true,
              },
            ),
          ]),
          people: [
            { ...alice, sessionCount: 1 },
            { identity: { type: "profile" as const, id: rawId }, sessionCount: 1 },
          ],
          peopleSessionCount: 2,
        };
        await installMockGateway(page, {
          sessionKey: "agent:main:named",
          methodResponses: {
            "sessions.list": {
              cases: [
                {
                  match: { involvingProfileId: rawId },
                  response: { ...listing, involvingProfileId: rawId },
                },
                { response: listing },
              ],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}activity`);
        await waitForControlUiRoute(page, { pathname: "/activity", routeId: "activity" });
        const activity = page.locator("openclaw-activity-page");
        const rowLink = (name: string) =>
          activity.locator(`[data-activity-session="agent:main:${name}"]`);
        const meta = (name: string) => rowLink(name).locator(".activity-feed__session-meta");
        await meta("unresolved").waitFor();

        expect(await meta("unresolved").textContent()).not.toContain(rawId);
        expect(await meta("unresolved").locator(".activity-feed__session-owner").count()).toBe(0);
        await expectCount(meta("unresolved").locator(".activity-feed__session-time")).toBe(1);
        await expectText(meta("named")).toContain("Alice Chen");
        // A person with no name gets the generic avatar, not the first digit of their id.
        await expectCount(rowLink("unresolved").locator(".activity-feed__unknown-avatar")).toBe(1);
        await expectCount(rowLink("unresolved").locator(".viewer-avatar__initials")).toBe(0);
        await expectText(rowLink("named").locator(".viewer-avatar__initials")).toBe("AC");

        // The filter and identity header still reach the full id.
        await activity.locator(".activity-feed__people-trigger").click();
        await page.locator(`[data-activity-unresolved] [data-activity-person="${rawId}"]`).click();
        await expectText(activity.locator(".activity-feed__identity h2")).toBe(rawId);
      },
    ));
});
