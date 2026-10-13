// Measures the lobster dismiss menu's internal overflow in the real New Session
// composer context, with classic (space-taking) scrollbars forced on so the
// Linux run matches what a macOS "Always show scrollbars" operator sees.
import type { BrowserContextOptions, Page } from "playwright";
import { expect, it } from "vitest";
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

type BrowserLobsterPet = HTMLElement & {
  mode: "idle" | "busy" | "offline";
  runOutcome: "ok" | "error" | "aborted";
  seed: number;
  visitsEnabled: boolean;
  updateComplete: Promise<unknown>;
};

/** Shared setup for a fresh page: mock gateway, load, and park the clock so
 *  the pet's own timers don't fire mid-assertion. Reused across the default
 *  1280x900 context and the per-test contexts below (compact/edge/theme). */
async function loadControlUiPage(currentPage: Page) {
  await currentPage.clock.install({ time: new Date("2026-07-09T12:00:00") });
  await installMockGateway(currentPage);
  await currentPage.goto(`${suite.server.baseUrl}new`);
  await currentPage.waitForFunction(() => Boolean(customElements.get("openclaw-lobster-pet")));
  await currentPage.locator("openclaw-app-sidebar").waitFor();
  await currentPage.locator(".new-session-page__message").waitFor();
  const loadedAt = await currentPage.evaluate(() => Date.now());
  await currentPage.clock.pauseAt(loadedAt + 1_000);
}

async function withDismissMenuPage(
  options: BrowserContextOptions,
  run: (page: Page) => Promise<void>,
) {
  await suite.withPage({ viewport: { width: 1280, height: 900 }, ...options }, async ({ page }) => {
    await loadControlUiPage(page);
    await run(page);
  });
}

/** Configures the pet already mounted on the real composer so production
 *  positioning and hit testing remain part of the assertion. */
async function configureRealComposerPet(currentPage: Page, seed: number) {
  await currentPage.evaluate(async (petSeed) => {
    const pet = document.querySelector("openclaw-lobster-pet") as BrowserLobsterPet | null;
    if (!pet) {
      throw new Error("composer lobster pet not found");
    }
    pet.seed = petSeed;
    pet.mode = "offline";
    pet.runOutcome = "ok";
    pet.visitsEnabled = true;
    await pet.updateComplete;
  }, seed);
}

/** Reads the geometry that decides whether the popup scrolls or overflows
 *  the viewport. */
async function measureDismissMenu(currentPage: Page) {
  return await currentPage.evaluate(() => {
    const menu = document.querySelector<HTMLElement>(".lobster-pet-dismiss-menu__panel");
    if (!menu) {
      throw new Error("dismiss menu not found");
    }
    const menuRect = menu.getBoundingClientRect();
    const host = document.querySelector<HTMLElement>("openclaw-lobster-pet");
    const firstItem = menu.querySelector<HTMLElement>('[role="menuitem"]');
    const firstItemLabel = firstItem?.querySelector<HTMLElement>(".oc-menu-item__label");
    const anchorRect = document
      .querySelector(".lobster-pet-dismiss-menu__trigger")
      ?.getBoundingClientRect();
    return {
      firstItemFontSizePx: firstItem
        ? Number.parseFloat(getComputedStyle(firstItem).fontSize)
        : null,
      firstItemLabelHeightPx: firstItemLabel?.getBoundingClientRect().height ?? null,
      overflowPx: menu.scrollHeight - menu.clientHeight,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      menuLeft: menuRect.left,
      menuRight: menuRect.right,
      menuTop: menuRect.top,
      menuBottom: menuRect.bottom,
      anchorLeft: anchorRect?.left,
      anchorTop: anchorRect?.top,
      popupIsTopLayer: menu.matches(":popover-open"),
      hasOuterMenuSurface: menu.closest("openclaw-menu-surface") !== null,
      hostParentClass: host?.parentElement?.className ?? null,
    };
  });
}

// The largest text-scale stop a user can actually pick from Appearance
// settings (TEXT_SCALE_STOPS in ui/src/app/settings.ts), applied the same
// way ui/src/app/bootstrap.ts:79 applies it at runtime.
const ENLARGED_TEXT_SCALE = "1.4";

/** Long labels and the real Appearance text-scale setting exercise the
 * owned menu's wrapping without depending on network-loaded locale chunks. */
async function useOversizedDismissLabels(currentPage: Page) {
  await currentPage.evaluate((scale) => {
    document.documentElement.style.setProperty("--control-ui-text-scale", scale);
    const labels = [
      "Postpone this lobster visit notice until the next scheduled maintenance window",
      "Permanently suppress every future lobster visit notice across all workspaces",
    ];
    document
      .querySelectorAll(".lobster-pet-dismiss-menu__panel .oc-menu-item__label")
      .forEach((item, index) => {
        item.textContent = labels[index] ?? item.textContent;
      });
  }, ENLARGED_TEXT_SCALE);
}

suite.define(() => {
  it("keeps the composer critter clickable and its dismissal menu inside the viewport", () =>
    withDismissMenuPage({}, async (page) => {
      await configureRealComposerPet(page, 42);
      const sprite = page.locator(".lobster-pet");
      await sprite.waitFor();
      // Native dismissal completion needs live animation frames.
      await page.clock.resume();
      const composer = page.locator(".new-session-page__message");
      await composer.focus();
      await sprite.click({ button: "right" });
      await page.getByText("Dismiss and don't show again", { exact: true }).waitFor();
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
      expect(measurement.menuTop).toBeGreaterThanOrEqual(0);
      expect(measurement.menuBottom).toBeLessThanOrEqual(measurement.viewportHeight);
      expect(await page.locator("openclaw-app-sidebar openclaw-lobster-pet").count()).toBe(0);
      const panel = page.locator(".lobster-pet-dismiss-menu__panel");
      await page.keyboard.press("Escape");
      expect(await composer.evaluate((input) => input === document.activeElement)).toBe(true);
      await panel.waitFor({ state: "detached" });
      expect(await sprite.count()).toBe(1);

      await sprite.click({ button: "right" });
      await panel.waitFor();
      await composer.click();
      await panel.waitFor({ state: "detached" });
      expect(await composer.evaluate((input) => input === document.activeElement)).toBe(true);
      expect(await sprite.count()).toBe(1);

      await sprite.click({ button: "right" });
      await panel.waitFor();
      await page.keyboard.press("Enter");
      expect(await composer.evaluate((input) => input === document.activeElement)).toBe(true);
      await expect.poll(() => sprite.count()).toBe(0);
    }));

  it("keeps both items fully visible under long labels and an enlarged type scale", () =>
    withDismissMenuPage({}, async (page) => {
      await configureRealComposerPet(page, 42);
      const sprite = page.locator(".lobster-pet");
      await sprite.waitFor();

      await sprite.click({ button: "right" });
      await page.locator(".lobster-pet-dismiss-menu__panel").waitFor();
      await page.getByText("Dismiss and don't show again", { exact: true }).waitFor();
      const baseline = await measureDismissMenu(page);

      await useOversizedDismissLabels(page);

      // Allow CSS anchor positioning to settle after the labels reflow.
      await expect
        .poll(async () => (await measureDismissMenu(page)).overflowPx, {
          message: "menu did not settle",
        })
        .toBe(0);
      const measurement = await measureDismissMenu(page);

      // Guards against --control-ui-text-scale/the label injection silently
      // no-opping: the rendered label font-size and its unclamped box height
      // must both actually grow, or this test would pass without exercising
      // the real type-scale token (the row's own height can't tell a real
      // increase from a no-op — see firstItemLabelHeightPx above).
      expect(measurement.firstItemFontSizePx).not.toBeNull();
      expect(measurement.firstItemFontSizePx).toBeGreaterThan(baseline.firstItemFontSizePx ?? 0);
      expect(measurement.firstItemLabelHeightPx).not.toBeNull();
      expect(measurement.firstItemLabelHeightPx).toBeGreaterThan(
        baseline.firstItemLabelHeightPx ?? 0,
      );
    }));

  it("keeps the popup within the viewport at a compact composer height", async () => {
    await withDismissMenuPage({ viewport: { width: 1280, height: 420 } }, async (shortPage) => {
      await configureRealComposerPet(shortPage, 42);
      const sprite = shortPage.locator(".lobster-pet");
      await sprite.waitFor();

      await sprite.click({ button: "right" });
      await shortPage.locator(".lobster-pet-dismiss-menu__panel").waitFor();
      await shortPage.getByText("Dismiss and don't show again", { exact: true }).waitFor();

      const measurement = await measureDismissMenu(shortPage);

      // The native anchor can flip or constrain the menu at short heights;
      // either placement must stay within the viewport.
      expect(measurement.menuTop).toBeGreaterThanOrEqual(0);
      expect(measurement.menuBottom).toBeLessThanOrEqual(measurement.viewportHeight);
    });
  });

  for (const edge of ["left", "right"] as const) {
    it(`keeps the popup within the viewport for pointer coordinates near the ${edge} edge`, () =>
      withDismissMenuPage({}, async (page) => {
        await configureRealComposerPet(page, 42);
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

        expect(measurement.menuLeft).toBeGreaterThanOrEqual(0);
        expect(measurement.menuRight).toBeLessThanOrEqual(measurement.viewportWidth);
        expect(measurement.anchorLeft).toBeCloseTo(point.clientX);
        expect(measurement.anchorTop).toBeCloseTo(point.clientY);
      }));
  }

  it("does not scroll its two dismissal items under a dark color scheme", async () => {
    await withDismissMenuPage(
      { viewport: { width: 1280, height: 900 }, colorScheme: "dark" },
      async (darkPage) => {
        await configureRealComposerPet(darkPage, 42);
        const sprite = darkPage.locator(".lobster-pet");
        await sprite.waitFor();

        await sprite.click({ button: "right" });
        await darkPage.locator(".lobster-pet-dismiss-menu__panel").waitFor();
        await darkPage.getByText("Dismiss and don't show again", { exact: true }).waitFor();

        const measurement = await measureDismissMenu(darkPage);

        expect(measurement).toMatchObject({ overflowPx: 0 });
      },
    );
  });
});
