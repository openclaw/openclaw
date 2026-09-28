import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { sourcePreviewFixture, sourcePreviewHistory } from "./chat-source-previews.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Chat source previews",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it.each([
    { name: "desktop", width: 1200, height: 900, colorScheme: "dark" as const, favicons: true },
    { name: "mobile", width: 390, height: 844, colorScheme: "light" as const, favicons: false },
  ])(
    "previews recorded sources and opens the original page ($name)",
    async ({ name, width, height, colorScheme, favicons }) => {
      const artifactDir = createControlUiE2eArtifactDir(`source-previews-${name}`);
      await suite.withPage(
        { viewport: { width, height }, colorScheme },
        async ({ page, context }) => {
          const fixture = sourcePreviewFixture;
          const requests: string[] = [];
          await context.route(
            /https:\/\/(cycling\.example\.com|weather\.example\.org)\//u,
            async (route) => {
              requests.push(route.request().url());
              await route.fulfill({ contentType: "text/html", body: "<h1>Recorded source</h1>" });
            },
          );
          const faviconRequests: string[] = [];
          await page.route("**/__openclaw__/link-favicon/**", async (route) => {
            faviconRequests.push(route.request().url());
            expect(route.request().headers()["authorization"]).toBe("Bearer e2e-device-token");
            await route.fulfill(
              route.request().url().endsWith("/cycling.example.com")
                ? {
                    contentType: "image/svg+xml",
                    body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#3879db"/><path d="M9 10h10a6 6 0 0 1 0 12H9z" fill="none" stroke="#fff" stroke-width="3"/></svg>',
                  }
                : { contentType: "image/png", body: "unavailable image" },
            );
          });
          const sessionUrl = controlUiSessionUrl(
            suite.server.baseUrl,
            "agent:main:dashboard:trip-planning",
          );
          await installMockGateway(page, {
            automaticallyFetchFavicons: favicons,
            historyMessages: sourcePreviewHistory(sessionUrl),
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, fixture.sessionKey));
          const cards = page.locator(".chat-source-card");
          await expect.poll(() => cards.count()).toBe(2);
          const checklist = cards.filter({ hasText: fixture.checklistTitle });
          const forecast = cards.filter({ hasText: fixture.forecastTitle });
          expect(
            await checklist.evaluate((element) => {
              const id = element.getAttribute("aria-controls");
              return Boolean(id && document.getElementById(id)?.matches("wa-popover"));
            }),
          ).toBe(true);
          expect(await checklist.textContent()).toContain("cycling.example.com");
          expect(await forecast.textContent()).toContain("weather.example.org");
          await page
            .locator(`a.markdown-session-link[data-session-href="${sessionUrl}"]`)
            .waitFor();
          await page
            .locator(
              'a.markdown-github-link[href="https://github.com/example/route-planner/issues/42"]',
            )
            .waitFor();
          const checklistIcon = checklist.locator("img");
          if (favicons) {
            await expect
              .poll(() => checklistIcon.evaluate((icon: HTMLImageElement) => icon.naturalWidth))
              .toBeGreaterThan(0);
            await expect.poll(() => forecast.locator("img").count()).toBe(0);
            expect(await forecast.locator(".chat-source-card__domain svg").count()).toBe(1);
            expect(faviconRequests.some((url) => url.endsWith("/cycling.example.com"))).toBe(true);
            expect(faviconRequests.some((url) => url.endsWith("/weather.example.org"))).toBe(true);
          } else {
            expect(await cards.locator("img").count()).toBe(0);
            expect(await cards.locator(".chat-source-card__domain svg").count()).toBe(2);
            expect(faviconRequests).toEqual([]);
          }
          expect(await page.locator(".chat-source-strip").textContent()).not.toContain(
            "City bike rentals",
          );
          if (name === "desktop") {
            const positions = await cards.evaluateAll((elements) =>
              elements.map((element) => element.getBoundingClientRect().top),
            );
            expect(positions[0]).toBe(positions[1]);
          }
          await page.screenshot({
            path: path.join(artifactDir, "sources.png"),
            animations: "disabled",
          });
          await checklist.click();
          await expect.poll(() => checklist.getAttribute("aria-expanded")).toBe("true");
          const popover = page.locator(`wa-popover[data-source-url="${fixture.checklistUrl}"]`);
          await expect
            .poll(() => popover.locator(".chat-source-popover__excerpt").isVisible())
            .toBe(true);
          expect(await popover.textContent()).toContain("Page excerpt");
          expect(await popover.textContent()).toContain("spare tube, tire levers, a pump");
          const openSource = popover.getByRole("link", { name: "Open source" });
          expect(await openSource.getAttribute("href")).toBe(fixture.checklistUrl);
          expect(await openSource.getAttribute("rel")).toContain("noopener");
          expect(requests).toEqual([]);
          await page.screenshot({
            path: path.join(artifactDir, "excerpt.png"),
            animations: "disabled",
          });
          const bounds = await popover.locator("section").boundingBox();
          expect(bounds).not.toBeNull();
          expect(bounds!.x).toBeGreaterThanOrEqual(0);
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
          const opened = context.waitForEvent("page");
          await openSource.click();
          const sourcePage = await opened;
          await sourcePage.waitForURL(fixture.checklistUrl);
          await sourcePage.close();
          await page.bringToFront();
          expect(requests).toEqual([fixture.checklistUrl]);
          await page.keyboard.press("Escape");
          await expect.poll(() => checklist.getAttribute("aria-expanded")).toBe("false");
          expect(await checklist.evaluate((element) => element === document.activeElement)).toBe(
            true,
          );

          await forecast.focus();
          await page.keyboard.press("Enter");
          await expect.poll(() => forecast.getAttribute("aria-expanded")).toBe("true");
          const forecastPopover = page.locator(
            `wa-popover[data-source-url="${fixture.forecastUrl}"]`,
          );
          await forecastPopover.getByText("Search snippet", { exact: true }).waitFor();
          expect(await forecastPopover.textContent()).toContain(
            "rain arriving on Sunday afternoon",
          );
          await forecastPopover.getByRole("button", { name: "Close", exact: true }).click();
          await expect.poll(() => forecast.getAttribute("aria-expanded")).toBe("false");
          expect(await forecast.evaluate((element) => element === document.activeElement)).toBe(
            true,
          );
          expect(requests).toEqual([fixture.checklistUrl]);
          await page.reload();
          await expect.poll(() => cards.count()).toBe(2);
          expect(await cards.first().getAttribute("aria-expanded")).toBe("false");
        },
      );
    },
  );
});
