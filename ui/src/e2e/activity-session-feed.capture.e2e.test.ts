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
        const gateway = await installMockGateway(page, {
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
        const toolbar = activity.locator(".activity-feed__toolbar");
        const time = toolbar.locator(".activity-feed__time-filter");
        const search = toolbar.locator(".activity-feed__search");
        const people = activity.locator(".activity-feed__people-trigger");
        const [toolbarBox, tabsBox, timeBox, searchBox, peopleBox] = await Promise.all([
          toolbar.boundingBox(),
          toolbar.locator(".activity-mode-tabs").boundingBox(),
          time.boundingBox(),
          search.boundingBox(),
          people.boundingBox(),
        ]);
        if (!toolbarBox || !tabsBox || !timeBox || !searchBox || !peopleBox) {
          throw new Error("Activity toolbar controls must be visible");
        }
        expect(Math.abs(tabsBox.x - toolbarBox.x)).toBeLessThan(2);
        expect(timeBox.x).toBeGreaterThan(toolbarBox.x + toolbarBox.width / 2);
        expect(tabsBox.x + tabsBox.width).toBeLessThanOrEqual(timeBox.x);
        expect(timeBox.x + timeBox.width).toBeLessThanOrEqual(searchBox.x);
        expect(searchBox.x + searchBox.width).toBeLessThanOrEqual(peopleBox.x);
        expect(
          Math.abs(peopleBox.x + peopleBox.width - toolbarBox.x - toolbarBox.width),
        ).toBeLessThan(2);
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
        await search.getByRole("button").click();
        const query = search.getByRole("searchbox");
        await query.fill("release");
        await waitForControlUiRoute(page, {
          pathname: `/activity/${alice.id}`,
          routeId: "activity",
          search: "?q=release",
        });
        const month = time.getByRole("button", { name: "Last 30 days", exact: true });
        await month.click();
        await waitForControlUiRoute(page, {
          pathname: `/activity/${alice.id}`,
          routeId: "activity",
          search: "?time=30d&q=release",
        });
        await expectAttribute(month, "aria-pressed").toBe("true");
        expect(await query.inputValue()).toBe("release");
        await gateway.waitForRequest("sessions.list", {
          match: { includeActivitySummary: true, involvingProfileId: alice.id, search: "release" },
        });
        await time.getByRole("button", { name: "Last 7 days", exact: true }).click();
        await waitForControlUiRoute(page, { routeId: "activity", search: "?q=release" });
        await search.getByRole("button", { name: "Close", exact: true }).click();
        await waitForControlUiRoute(page, { routeId: "activity", search: "" });
        await activity.locator(".activity-feed__people-clear").click();
        await waitForControlUiRoute(page, { pathname: "/activity", routeId: "activity" });
        await group.waitFor();
        await page.setViewportSize({ height: 844, width: 390 });
        await time.waitFor();
        const buttonTops = await time
          .locator(".settings-segmented__btn")
          .evaluateAll((buttons) =>
            buttons.map((button) => Math.round(button.getBoundingClientRect().top)),
          );
        expect(buttonTops).toHaveLength(4);
        expect(new Set(buttonTops)).toHaveLength(1);
        await expect
          .poll(async () => {
            const [phoneSearchBox, phonePeopleBox] = await Promise.all([
              activity.locator(".activity-feed__search").boundingBox(),
              activity.locator(".activity-feed__people-control").boundingBox(),
            ]);
            return phoneSearchBox && phonePeopleBox
              ? Math.abs(phoneSearchBox.y - phonePeopleBox.y)
              : Number.POSITIVE_INFINITY;
          })
          .toBeLessThan(2);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        // The row reads title, one meta line, then Inspect run closing the recap.
        await expectText(liveRow.locator(".activity-feed__session-meta")).toContain("Alice Chen");
        const phoneInspect = feed.locator(
          `[data-activity-recap="${key}"] .activity-feed__inspect-run`,
        );
        expect(await phoneInspect.getAttribute("href")).toBe(
          "/activity?view=run&run=mock%20run%3Aa%2Fb",
        );
        // The person filter keeps its active trigger and removable chip on phones.
        await people.click();
        await page.locator(`[data-activity-person="${alice.id}"]`).click();
        await waitForControlUiRoute(page, {
          pathname: `/activity/${alice.id}`,
          routeId: "activity",
        });
        await expect
          .poll(() => people.evaluate((el) => el.classList.contains("active")))
          .toBe(true);
        await activity.locator(".activity-feed__people-clear").waitFor();
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

  it("keeps Live status filters and actions usable in the phone toolbar", () =>
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
        for (const [id, name, isError] of [
          ["call-one", "read", false],
          ["call-two", "exec", true],
        ] as const) {
          await gateway.emitGatewayEvent("session.tool", {
            stream: "tool",
            runId: "live-run",
            sessionKey: key,
            data: { toolCallId: id, name, phase: "result", isError, result: { text: id } },
          });
        }
        const entries = activity.locator(".activity-entry");
        await expectCount(entries).toBe(2);

        const toolbar = activity.locator(".activity-live-toolbar");
        const trigger = toolbar.locator("#activity-live-filter-trigger");
        const statuses = toolbar.locator(".activity-status-filter");
        await expectCount(statuses).toBe(3);
        for (const status of await statuses.all()) {
          await status.waitFor();
        }
        await toolbar.locator(".activity-live-autofollow").getByRole("switch").waitFor();
        await statuses.nth(1).click();
        await expectCount(entries).toBe(1);
        await expectAttribute(statuses.nth(1), "aria-pressed").toBe("false");
        await statuses.nth(1).click();
        await expectCount(entries).toBe(2);
        await expectAttribute(statuses.nth(1), "aria-pressed").toBe("true");

        await trigger.click();
        const panel = activity.locator(".activity-live-filter-popover:popover-open");
        await panel.getByRole("combobox").selectOption("read");
        await expectCount(entries).toBe(1);
        await expect
          .poll(() => trigger.evaluate((el) => el.classList.contains("active")))
          .toBe(true);
        await panel.getByRole("combobox").selectOption("");
        await expectCount(entries).toBe(2);
        await expect
          .poll(() => trigger.evaluate((el) => el.classList.contains("active")))
          .toBe(false);
        await page.keyboard.press("Escape");

        const actions = toolbar.locator(".activity-live-actions__trigger");
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

  it("keeps unnamed people private when filtering their phone activity", () =>
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

        // Selecting the full identity keeps its unnamed heading private.
        await activity.locator(".activity-feed__people-trigger").click();
        await page.locator(`[data-activity-unresolved] [data-activity-person="${rawId}"]`).click();
        await expectText(activity.locator(`[data-activity-identity="${rawId}"] h2`)).toBe("Person");
      },
    ));
});
