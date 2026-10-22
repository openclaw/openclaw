// Force classic scrollbars to reproduce macOS "Always show scrollbars" overflow.
import type { BrowserContextOptions, Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { LobsterPetElement as BrowserLobsterPet } from "../components/lobster-pet.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installMockGateway } from "./new-session-page.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI lobster dismiss menu overflow",
  startServerBeforeBrowser: true,
  browserLaunchOptions: {
    args: ["--disable-features=OverlayScrollbar,FluentOverlayScrollbar,FluentScrollbar"],
  },
  unavailableMessage: (executablePath) => `Playwright Chromium cannot start at ${executablePath}`,
});

async function withDismissMenuPage(
  options: BrowserContextOptions,
  run: (page: Page) => Promise<void>,
) {
  await suite.withPage({ viewport: { width: 1280, height: 900 }, ...options }, async ({ page }) => {
    await page.clock.install({ time: new Date("2026-07-09T12:00:00") });
    await installMockGateway(page);
    await page.goto(`${suite.server.baseUrl}new`);
    await page.waitForFunction(() => Boolean(customElements.get("openclaw-lobster-pet")));
    await page.locator("openclaw-app-sidebar").waitFor();
    await page.locator(".new-session-page__message").waitFor();
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);
    await page.locator("openclaw-lobster-pet").evaluate(async (element) => {
      const pet = element as BrowserLobsterPet;
      Object.assign(pet, { seed: 42, mode: "offline", runOutcome: "ok", visitsEnabled: true });
      await pet.updateComplete;
    });
    await run(page);
  });
}

async function measureDismissMenu(currentPage: Page) {
  return currentPage.locator(".lobster-pet-dismiss-menu__panel").evaluate((menu) => {
    const { top, bottom, left, right } = menu.getBoundingClientRect();
    const host = document.querySelector<HTMLElement>("openclaw-lobster-pet");
    const firstItem = menu.querySelector<HTMLElement>('[role="menuitem"]')!;
    const firstItemLabel = firstItem.querySelector<HTMLElement>(".oc-menu-item__label")!;
    const anchorRect = document
      .querySelector(".lobster-pet-dismiss-menu__trigger")
      ?.getBoundingClientRect();
    return {
      firstItemFontSizePx: Number.parseFloat(getComputedStyle(firstItem).fontSize),
      firstItemLabelHeightPx: firstItemLabel.getBoundingClientRect().height,
      overflowPx: menu.scrollHeight - menu.clientHeight,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      top,
      bottom,
      left,
      right,
      anchorLeft: anchorRect?.left,
      anchorTop: anchorRect?.top,
      popupIsTopLayer: menu.matches(":popover-open"),
      hasOuterMenuSurface: menu.closest("openclaw-menu-surface") !== null,
      hostParentClass: host?.parentElement?.className ?? null,
    };
  });
}

async function expectFocused(target: Locator) {
  expect(await target.evaluate((element) => element === document.activeElement)).toBe(true);
}

async function openDismissMenu(page: Page) {
  const sprite = page.locator(".lobster-pet");
  await sprite.waitFor();
  await sprite.click({ button: "right" });
  await page.locator(".lobster-pet-dismiss-menu__panel").waitFor();
  await page.getByText("Dismiss and don't show again", { exact: true }).waitFor();
}

suite.define(() => {
  it("keeps the composer critter clickable and its dismissal menu inside the viewport", () =>
    withDismissMenuPage({}, async (page) => {
      const sprite = page.locator(".lobster-pet");
      // Native dismissal completion needs live animation frames.
      await page.clock.resume();
      const composer = page.locator(".new-session-page__message");
      await composer.focus();
      await openDismissMenu(page);
      await expect
        .poll(() =>
          page
            .getByRole("menuitem", { name: "Dismiss", exact: true })
            .evaluate((item) => item === document.activeElement),
        )
        .toBe(true);
      const measurement = await measureDismissMenu(page);
      expect(measurement).toMatchObject({
        overflowPx: 0,
        popupIsTopLayer: true,
        hasOuterMenuSurface: false,
      });
      expect(measurement.hostParentClass).toContain("agent-chat__input");
      expect(measurement.top).toBeGreaterThanOrEqual(0);
      expect(measurement.bottom).toBeLessThanOrEqual(measurement.viewportHeight);
      expect(await page.locator("openclaw-app-sidebar openclaw-lobster-pet").count()).toBe(0);
      const panel = page.locator(".lobster-pet-dismiss-menu__panel");
      await page.keyboard.press("Escape");
      await expectFocused(composer);
      await panel.waitFor({ state: "detached" });
      expect(await sprite.count()).toBe(1);

      await openDismissMenu(page);
      await composer.click();
      await panel.waitFor({ state: "detached" });
      await expectFocused(composer);
      expect(await sprite.count()).toBe(1);

      await openDismissMenu(page);
      await page.keyboard.press("Enter");
      await expectFocused(composer);
      await expect.poll(() => sprite.count()).toBe(0);
    }));

  it("keeps both items fully visible under long labels and an enlarged type scale", () =>
    withDismissMenuPage({}, async (page) => {
      await openDismissMenu(page);
      const baseline = await measureDismissMenu(page);

      await page.evaluate(() => {
        document.documentElement.style.setProperty("--control-ui-text-scale", "1.4");
        const labels = [
          "Postpone this lobster visit notice until the next scheduled maintenance window",
          "Permanently suppress every future lobster visit notice across all workspaces",
        ];
        document
          .querySelectorAll(".lobster-pet-dismiss-menu__panel .oc-menu-item__label")
          .forEach((item, index) => {
            item.textContent = labels[index] ?? item.textContent;
          });
      });

      await expect
        .poll(async () => (await measureDismissMenu(page)).overflowPx, {
          message: "menu did not settle",
        })
        .toBe(0);
      const measurement = await measureDismissMenu(page);

      expect(measurement.firstItemFontSizePx).toBeGreaterThan(baseline.firstItemFontSizePx);
      expect(measurement.firstItemLabelHeightPx).toBeGreaterThan(baseline.firstItemLabelHeightPx);
    }));

  it("keeps the popup within the viewport at a compact composer height", () =>
    withDismissMenuPage({ viewport: { width: 1280, height: 420 } }, async (shortPage) => {
      await openDismissMenu(shortPage);

      const measurement = await measureDismissMenu(shortPage);

      expect(measurement.top).toBeGreaterThanOrEqual(0);
      expect(measurement.bottom).toBeLessThanOrEqual(measurement.viewportHeight);
    }));

  for (const edge of ["left", "right"] as const) {
    it(`keeps the popup within the viewport for pointer coordinates near the ${edge} edge`, () =>
      withDismissMenuPage({}, async (page) => {
        // Exercise the popup's raw pointer-coordinate boundary without moving
        // the composer outside its scroll container and invalidating its lanes.
        const sprite = page.locator(".lobster-pet");
        await sprite.waitFor();
        const point = await sprite.evaluate(
          (element, direction) => ({
            clientX: direction === "left" ? 12 : innerWidth - 12,
            clientY: Math.trunc(element.getBoundingClientRect().top + 12),
          }),
          edge,
        );
        await sprite.evaluate((element, position) => {
          element.dispatchEvent(
            new MouseEvent("contextmenu", { ...position, bubbles: true, cancelable: true }),
          );
        }, point);
        await page.locator(".lobster-pet-dismiss-menu__panel").waitFor();
        await page.clock.runFor(150);

        const measurement = await measureDismissMenu(page);

        expect(measurement.left).toBeGreaterThanOrEqual(0);
        expect(measurement.right).toBeLessThanOrEqual(measurement.viewportWidth);
        expect(measurement.anchorLeft).toBeCloseTo(point.clientX);
        expect(measurement.anchorTop).toBeCloseTo(point.clientY);
      }));
  }

  it("does not scroll its two dismissal items under a dark color scheme", () =>
    withDismissMenuPage({ colorScheme: "dark" }, async (darkPage) => {
      await openDismissMenu(darkPage);

      const measurement = await measureDismissMenu(darkPage);

      expect(measurement).toMatchObject({ overflowPx: 0 });
    }));
});
