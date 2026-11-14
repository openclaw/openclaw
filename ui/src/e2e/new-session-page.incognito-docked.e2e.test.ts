import type { Page } from "playwright";
import { expect, it } from "vitest";
import { waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const NOTE = ".new-session-page__incognito-note";

// Everything on the draft that turning Incognito on or off must leave in place.
const layout = (page: Page) =>
  page.evaluate(() =>
    [
      ".agent-chat__welcome-avatar",
      ".agent-chat__welcome-name",
      // Short layouts hide the hint; there the status line floats clear of the identity.
      ...(window.innerHeight > 500 ? [".agent-chat__hint"] : []),
      ".new-session-page__trigger",
      ".new-session-page__composer",
      ".agent-chat__input",
      ".new-session-page__message",
      ".new-session-page__draft-toggle",
      ".new-session-page__incognito-toggle",
    ].flatMap((selector) =>
      [...document.querySelectorAll(selector)].map((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { selector, box: [x, y, width, height] };
      }),
    ),
  );

const openDraft = async (page: Page) => {
  await installMockGateway(page);
  await page.goto(`${suite.server.baseUrl}new?agent=main`);
  await waitForControlUiRoute(page, { routeId: "new-session", pathname: "/new" });
  await page.locator(".new-session-page__message").waitFor();
};

suite.define(() => {
  it.each([
    { width: 390, height: 844 },
    { width: 320, height: 568 },
    { width: 844, height: 390 },
  ])("keeps the docked draft in place across Incognito at $width x $height", async (viewport) => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", reducedMotion: "reduce", viewport },
      async ({ page }) => {
        await openDraft(page);
        const incognito = page.getByRole("switch", { name: "Incognito" });
        const note = page.locator(NOTE);
        const status = page.locator(".new-session-page__incognito-status");
        const before = await layout(page);
        expect(await status.isVisible()).toBe(false);

        await incognito.click();
        await note.waitFor({ state: "visible" });
        expect(await note.textContent()).toContain("History expires 24 hours");
        expect(await note.textContent()).toContain("Your model provider still processes messages");
        // The notice only remains as a status announcement here.
        expect(
          await page
            .locator(".new-session-page__incognito-notice")
            .evaluate((element) => element.getBoundingClientRect().height),
        ).toBeLessThanOrEqual(1);
        expect(await layout(page)).toEqual(before);

        // Any tap outside dismisses it, and the line brings it back.
        await page.locator(".new-session-page__message").click({ position: { x: 8, y: 40 } });
        await note.waitFor({ state: "hidden" });
        expect(
          await page
            .locator(".new-session-page__message")
            .evaluate((element) => element === document.activeElement),
        ).toBe(true);
        await status.click();
        await note.waitFor({ state: "visible" });
        // Where it covers the composer, tapping the note itself gets it out of the way.
        await note.click();
        await note.waitFor({ state: "hidden" });
        await status.click();
        await note.waitFor({ state: "visible" });
        expect(await layout(page)).toEqual(before);

        await incognito.click();
        await note.waitFor({ state: "hidden" });
        expect(await incognito.getAttribute("aria-checked")).toBe("false");
        expect(await status.isVisible()).toBe(false);
        expect(await layout(page)).toEqual(before);
      },
    );
  });

  it("keeps the inline notice and no status line at desktop width", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 800 } },
      async ({ page }) => {
        await openDraft(page);
        await page.getByRole("switch", { name: "Incognito" }).click();
        const notice = page.locator(".new-session-page__incognito-notice");
        await expect.poll(() => notice.isVisible()).toBe(true);
        await expect
          .poll(() => notice.evaluate((element) => element.getBoundingClientRect().height))
          .toBeGreaterThan(10);
        expect(await page.locator(".new-session-page__incognito-toggle-label").isVisible()).toBe(
          true,
        );
        expect(await page.locator(".new-session-page__incognito-status").isVisible()).toBe(false);
        expect(await page.locator(NOTE).isVisible()).toBe(false);
      },
    );
  });
});
