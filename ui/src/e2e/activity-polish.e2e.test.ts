import path from "node:path";
import { expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  activityPolishFixture,
  activityPolishImages,
  activityPolishKeys,
  activityPolishPullRequest,
} from "./activity-polish.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Activity recap and screenshot polish" });

suite.define(() => {
  it.each([1440, 390])("retains the screenshot grid while refreshing at %s px", async (width) => {
    await suite.withPage(
      { viewport: { width, height: 1000 }, colorScheme: "light", locale: "en-US" },
      async ({ page }) => {
        const fixture = activityPolishFixture();
        const gateway = await installMockGateway(page, fixture.scenario);
        await page.goto(`${suite.server.baseUrl}activity`);
        await gateway.waitForRequest("sessions.list", {
          match: { includeActivitySummary: true },
        });
        const images = await activityPolishImages(page);
        await gateway.setMethodResponse("artifacts.list", {
          cases: [
            { match: { sessionKey: activityPolishKeys.current, type: "image" }, response: images },
            { response: { artifacts: [] } },
          ],
        });
        await gateway.resolveDeferred("sessions.list", fixture.list);
        const row = page.locator(".activity-feed__session-row").filter({
          has: page.locator(`[data-activity-session="${activityPolishKeys.current}"]`),
        });
        const thumbnails = row.locator(".chat-message-image-button");
        await expect.poll(() => thumbnails.count()).toBe(4);
        await expect
          .poll(() =>
            thumbnails
              .locator("img")
              .evaluateAll((elements) =>
                elements.every(
                  (element) =>
                    element instanceof HTMLImageElement &&
                    element.complete &&
                    element.naturalWidth > 0,
                ),
              ),
          )
          .toBe(true);
        const match = { sessionKey: activityPolishKeys.current, type: "image" };
        const requests = (await gateway.getRequests("artifacts.list", match)).length;
        await gateway.deferNext("artifacts.list", match);
        const label = "Repair duplicate notifications: checking follow-up";
        await gateway.setSessionsListResponse({
          ...fixture.list,
          sessions: fixture.list.sessions.map((session) =>
            session.key === activityPolishKeys.current
              ? Object.assign({}, session, { label, updatedAt: Date.now() })
              : session,
          ),
        });
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey: activityPolishKeys.current,
          reason: "update",
        });
        await expect.poll(() => row.textContent()).toContain(label);
        await expect
          .poll(async () => (await gateway.getRequests("artifacts.list", match)).length)
          .toBe(requests + 1);
        try {
          await page.screenshot({
            path: path.join(suite.artifactDir, `refresh-gallery-${width}.png`),
          });
          expect(await thumbnails.count()).toBe(4);
        } finally {
          await gateway.resolveDeferred("artifacts.list", images);
        }
        await expect.poll(() => thumbnails.count()).toBe(4);
      },
    );
  });

  it.each([
    { width: 1440, height: 1100, colorScheme: "light" as const },
    { width: 390, height: 844, colorScheme: "dark" as const },
  ])(
    "keeps Activity understandable during loading, refresh failure and media expansion at $width px",
    async ({ width, height, colorScheme }) => {
      await suite.withPage(
        { viewport: { width, height }, colorScheme, locale: "en-US" },
        async ({ page }) => {
          const fixture = activityPolishFixture();
          const gateway = await installMockGateway(page, fixture.scenario);
          await page.goto(`${suite.server.baseUrl}activity`);
          await gateway.waitForRequest("sessions.list", {
            match: { includeActivitySummary: true },
          });
          const loading = page.locator(".activity-feed__loading");
          await loading.waitFor();
          expect(await loading.getAttribute("aria-busy")).toBe("true");
          expect(await loading.locator(".skeleton").count()).toBeGreaterThan(0);
          await page.screenshot({ path: path.join(suite.artifactDir, `01-loading-${width}.png`) });

          const images = await activityPolishImages(page);
          await gateway.setMethodResponse("artifacts.list", {
            cases: [
              {
                match: { sessionKey: activityPolishKeys.current, type: "image" },
                response: images,
              },
              { response: { artifacts: [] } },
            ],
          });
          await gateway.resolveDeferred("sessions.list", fixture.list);
          const activity = page.locator("openclaw-activity-page");
          const recap = (key: string) => activity.locator(`[data-activity-recap="${key}"]`);
          const row = (key: string) =>
            activity
              .locator(".activity-feed__session-row")
              .filter({ has: page.locator(`[data-activity-session="${key}"]`) });
          await expect.poll(() => activity.locator("[data-activity-session]").count()).toBe(4);
          expect(
            await activity
              .locator("[data-activity-session]")
              .evaluateAll((links) =>
                links.map((link) => link.getAttribute("data-activity-session")),
              ),
          ).toEqual(Object.values(activityPolishKeys));
          const listRequest = await gateway.waitForRequest("sessions.list", {
            match: { includeActivitySummary: true },
          });
          expect(listRequest.params).toMatchObject({ sortBy: "activity" });
          expect(
            await row(activityPolishKeys.current)
              .locator(".activity-feed__session-time")
              .textContent(),
          ).toContain("1m");
          await expect
            .poll(() => row(activityPolishKeys.current).locator(".agent-row-chip").textContent())
            .toContain("Roboclaw");
          expect(
            await row(activityPolishKeys.current)
              .locator(".activity-feed__session-meta")
              .textContent(),
          ).toContain("Alex Morgan");
          expect(await recap(activityPolishKeys.updating).getAttribute("aria-busy")).toBe("true");
          expect(await recap(activityPolishKeys.updating).locator("p").textContent()).toContain(
            "Testing focus behavior",
          );
          expect(
            await recap(activityPolishKeys.updating)
              .locator(".activity-feed__recap-feedback")
              .count(),
          ).toBe(0);
          expect(await recap(activityPolishKeys.unavailable).textContent()).toContain(
            "Couldn’t refresh recap",
          );
          expect(await recap(activityPolishKeys.unavailable).textContent()).not.toContain(
            "Recap unavailable",
          );
          expect(await recap(activityPolishKeys.initial).locator(".skeleton").count()).toBe(2);
          const thumbnails = row(activityPolishKeys.current).locator(".chat-message-image-button");
          await expect.poll(() => thumbnails.count()).toBe(4);
          await expect
            .poll(() =>
              thumbnails
                .locator("img")
                .evaluateAll((elements) =>
                  elements.every(
                    (element) =>
                      element instanceof HTMLImageElement &&
                      element.complete &&
                      element.naturalWidth > 0,
                  ),
                ),
            )
            .toBe(true);
          const imageRequest = await gateway.waitForRequest("artifacts.list", {
            match: { sessionKey: activityPolishKeys.current },
          });
          expect(imageRequest.params).toMatchObject({ agentId: "main", type: "image", limit: 4 });
          expect(await gateway.getRequests("chat.history")).toEqual([]);
          await gateway.emitGatewayEvent(
            CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
            fixture.pullRequests,
          );
          const pr = row(activityPolishKeys.current).locator(".activity-feed__pr");
          await pr.waitFor();
          await page.screenshot({ path: path.join(suite.artifactDir, `02-recaps-${width}.png`) });
          await pr.focus();
          const card = page.locator(".github-link-hovercard");
          await expect.poll(() => card.textContent()).toContain(activityPolishPullRequest.title);
          await gateway.waitForRequest("controlUi.githubPreview");
          await gateway.rejectDeferred("controlUi.githubPreview", {
            code: "UNAVAILABLE",
            message: "Preview enrichment unavailable",
          });
          await expect.poll(() => card.textContent()).toContain(activityPolishPullRequest.title);
          await page.screenshot({ path: path.join(suite.artifactDir, `03-hover-${width}.png`) });
          await page.keyboard.press("Escape");
          await thumbnails.first().click();
          const lightbox = page.locator("openclaw-image-lightbox");
          await lightbox.locator("img").waitFor();
          await expect
            .poll(() =>
              lightbox
                .locator("img")
                .evaluate(
                  (element) => element instanceof HTMLImageElement && element.naturalWidth > 0,
                ),
            )
            .toBe(true);
          await page.screenshot({ path: path.join(suite.artifactDir, `04-expanded-${width}.png`) });
          await page.keyboard.press("Escape");
          await lightbox.waitFor({ state: "detached" });
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
        },
      );
    },
  );
});
