import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
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
  it("scrolls the session feed from both page margins without moving the desktop filters", () =>
    suite.withPage(
      { locale: "en-US", colorScheme: "light", viewport: { height: 900, width: 1600 } },
      async ({ page }) => {
        const now = Date.now();
        const sessions = Array.from({ length: 40 }, (_, index) => ({
          key: `agent:main:activity-scroll-${index}`,
          kind: "direct",
          label: `Review session ${String(index + 1).padStart(2, "0")}`,
          updatedAt: now - index * 60_000,
          createdActor: { type: "human" as const, ...alice },
          activitySummary: {
            state: "current",
            text: "Reviewed the proposed changes and recorded the remaining follow-up work.",
            updatedAt: now,
          },
        }));
        await installMockGateway(page, {
          sessionKey: "agent:main:activity-scroll-0",
          methodResponses: { "sessions.list": chatSessionListResponse(sessions) },
        });
        await page.goto(`${suite.server.baseUrl}activity`);
        await expectCount(page.locator("[data-activity-session]")).toBe(sessions.length);
        const firstRow = page.locator("[data-activity-session]").first();
        const toolbar = page.locator(".activity-feed__toolbar");
        const main = page.locator("main.content");

        for (const width of [1600, 820, 390]) {
          await page.setViewportSize({ width, height: 900 });
          await firstRow.hover();
          const bounds = await main.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return {
              left: rect.left + Number.parseFloat(getComputedStyle(element).borderLeftWidth),
              right: rect.right,
            };
          });
          const toolbarTop = (await toolbar.boundingBox())!.y;
          for (const [side, x] of [
            ["left", bounds.left + 8],
            ["right", bounds.right - 8],
            ["center", (bounds.left + bounds.right) / 2],
          ] as const) {
            const rowTop = (await firstRow.boundingBox())!.y;
            await page.mouse.move(x, 650);
            await page.mouse.wheel(0, 300);
            try {
              await expect
                .poll(async () => (await firstRow.boundingBox())!.y)
                .toBeLessThan(rowTop - 100);
            } finally {
              if (
                process.env.OPENCLAW_CAPTURE_UI_PROOF === "1" &&
                width === 1600 &&
                side === "left"
              ) {
                const frame = await takeControlUiScreenshotFrame(page, main, [toolbar], {
                  animations: "disabled",
                });
                await writeFile(
                  path.join(suite.artifactDir, "activity-margin-scroll.png"),
                  frame.png,
                );
              }
            }
            if (width > 768) {
              expect((await toolbar.boundingBox())!.y).toBe(toolbarTop);
            }
            await page.mouse.wheel(0, -300);
            await expect
              .poll(async () => (await firstRow.boundingBox())!.y, {
                message: `Return to the starting row position at ${width}px from the ${side}`,
              })
              .toBe(rowTop);
          }
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
        }
      },
    ));

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

  it("aligns phone activity and its people filter without exposing unnamed identities", () =>
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
        await activity.locator(".activity-feed__sessions").waitFor();
        const pageEdge = (await activity.locator(".page-subtitle").boundingBox())!.x;
        for (const selector of [".activity-feed__search", ".activity-feed__sessions"]) {
          expect((await activity.locator(selector).first().boundingBox())!.x).toBe(pageEdge);
        }
        const tabLabelEdge = await activity
          .getByRole("tab", { name: "Sessions" })
          .evaluate((tab) => {
            const label = document.createRange();
            label.selectNodeContents(tab);
            return label.getBoundingClientRect().left;
          });
        expect(Math.abs(tabLabelEdge - pageEdge)).toBeLessThanOrEqual(1);
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
        const labelEdges = await activity
          .locator(".activity-feed__people-name")
          .evaluateAll((labels) => labels.map((label) => label.getBoundingClientRect().left));
        expect(new Set(labelEdges).size).toBe(1);
        await page.locator(`[data-activity-unresolved] [data-activity-person="${rawId}"]`).click();
        await expectText(activity.locator(`[data-activity-identity="${rawId}"] h2`)).toBe("Person");
      },
    ));
});
