import path from "node:path";
import { expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import {
  buildControlUiCspHeader,
  computeInlineScriptHashes,
} from "../../../src/gateway/control-ui-csp.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { TEST_LINK_READER } from "../test-helpers/link-reader.ts";
import {
  activityPolishFixture,
  activityPolishImages,
  activityPolishKeys,
  activityPolishPullRequest,
} from "./activity-polish.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Activity recap and screenshot polish" });

suite.define(() => {
  it.each([1440, 390])("loads remote previews during refresh at %s px", async (width) => {
    await suite.withPage(
      { viewport: { width, height: 1000 }, colorScheme: "light", locale: "en-US" },
      async ({ page }) => {
        const fixture = activityPolishFixture();
        const gateway = await installMockGateway(page, fixture.scenario);
        await page.route(`${suite.server.baseUrl}activity`, async (route) => {
          const response = await route.fetch();
          await route.fulfill({
            response,
            headers: {
              ...response.headers(),
              "Content-Security-Policy": buildControlUiCspHeader({
                inlineScriptHashes: computeInlineScriptHashes(await response.text()),
              }),
            },
          });
        });
        await page.goto(`${suite.server.baseUrl}activity`);
        await gateway.waitForRequest("sessions.list", {
          match: { includeActivitySummary: true },
        });
        const images = await activityPolishImages(page);
        const referrers: Array<string | undefined> = [];
        for (const [index, artifact] of images.artifacts.entries()) {
          const badge = index === 3;
          const body = badge
            ? Buffer.from(
                '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="24"><rect width="120" height="24" rx="4" fill="#15803d"/><text x="60" y="16" text-anchor="middle" fill="white" font-family="sans-serif" font-size="12">release: ready</text></svg>',
              )
            : Buffer.from(artifact.image.url.split(",")[1]!, "base64");
          artifact.image.url = badge
            ? "https://img.shields.io/badge/release-ready"
            : `https://images.example.test/screenshot-${index}.png`;
          await page.route(artifact.image.url, async (route) => {
            referrers.push((await route.request().allHeaders()).referer);
            await route.fulfill({
              contentType: badge ? "image/svg+xml" : "image/png",
              headers: { "Cache-Control": "no-store" },
              body,
            });
          });
        }
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
        const row = page.locator(".activity-feed__session-row").filter({
          has: page.locator(`[data-activity-session="${activityPolishKeys.current}"]`),
        });
        const thumbnails = row.locator(".chat-message-image-button");
        await expect.poll(() => thumbnails.count()).toBe(4);
        await thumbnails.first().focus();
        for (let index = 1; index < 4; index++) {
          await page.keyboard.press("Tab");
          expect(
            await thumbnails.nth(index).evaluate((element) => element === document.activeElement),
          ).toBe(true);
        }
        await expect.poll(() => thumbnails.locator("img").count()).toBe(4);
        await expect
          .poll(() =>
            thumbnails
              .locator("img")
              .evaluateAll((elements) =>
                elements.every(
                  (element) => element instanceof HTMLImageElement && element.complete,
                ),
              ),
          )
          .toBe(true);
        await page.screenshot({
          path: path.join(suite.artifactDir, `remote-previews-${width}.png`),
        });
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
        expect(referrers).toHaveLength(4);
        expect(referrers.every((referrer) => referrer === undefined)).toBe(true);
        await thumbnails.last().focus();
        await page.keyboard.press("Enter");
        const expandedImage = page.locator("openclaw-image-lightbox img");
        await expect
          .poll(() =>
            expandedImage.evaluate(
              (element) => element instanceof HTMLImageElement && element.naturalWidth > 0,
            ),
          )
          .toBe(true);
        await page.getByRole("button", { name: "Previous image", exact: true }).click();
        await expect
          .poll(() => expandedImage.getAttribute("src"))
          .toBe(images.artifacts[2]!.image.url);
        expect(referrers.every((referrer) => referrer === undefined)).toBe(true);
        await page.keyboard.press("Escape");
        await page.locator("openclaw-image-lightbox").waitFor({ state: "detached" });
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
          const boxes = await thumbnails.evaluateAll((elements) =>
            elements.map((element) => {
              const rect = element.getBoundingClientRect();
              return { top: rect.top, height: rect.height, width: rect.width };
            }),
          );
          expect(
            Math.max(...boxes.map((box) => box.top)) - Math.min(...boxes.map((box) => box.top)),
          ).toBeLessThanOrEqual(1);
          expect(boxes.every((box) => box.height <= 80 && box.width <= 128)).toBe(true);
          await pr.focus();
          const card = page.locator(".link-reader-hovercard");
          await expect.poll(() => card.textContent()).toContain(activityPolishPullRequest.title);
          await gateway.waitForRequest(TEST_LINK_READER.linkReader.previewMethod!);
          await gateway.rejectDeferred(TEST_LINK_READER.linkReader.previewMethod!, {
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
