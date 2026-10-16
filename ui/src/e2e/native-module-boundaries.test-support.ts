import type { Locator } from "playwright";
import { describe, expect, it } from "vitest";
import {
  type createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";
import { createNativeNavPageOpener } from "./native-nav-page.test-support.ts";

const expectAnimation = async (
  element: Locator,
  property: "animationName" | "animationDuration",
  value: string,
) =>
  expect(await element.evaluate((node, key) => getComputedStyle(node)[key], property)).toBe(value);

export function defineNativeModuleBoundaryTests(
  suite: ReturnType<typeof createControlUiE2eSuite>,
  moduleRequest: (sourcePath: string) => RegExp,
) {
  describe("Native navigation module loading", () => {
    const openPage = createNativeNavPageOpener(suite);
    async function openHeldPage(source: string, options: Parameters<typeof openPage>[0] = {}) {
      let held!: Awaited<ReturnType<typeof holdModuleResponse>>;
      const page = await openPage({
        ...options,
        beforeNavigate: async (target) => {
          await options.beforeNavigate?.(target);
          held = await holdModuleResponse(target, moduleRequest(`ui/src/${source}`));
        },
      });
      return { page, held };
    }

    it("closes navigation while the sidebar element is still unregistered", async () => {
      const errors: string[] = [];
      const { page, held } = await openHeldPage("components/app-sidebar.tsx", {
        pathname: "new",
        readySelector: ".new-session-page__message",
        width: 900,
        beforeNavigate: async (targetPage) => {
          targetPage.on("pageerror", (error) => errors.push(error.message));
        },
      });
      await held.request;
      const element = page.locator("openclaw-app-sidebar").first();
      expect(await element.evaluate((node) => node.matches(":defined"))).toBe(false);
      const toggle = page.locator(".topbar-nav-toggle");
      const navigation = page.getByRole("dialog", { name: "Navigation" });
      const openAndClose = async (close: () => Promise<unknown>) => {
        await toggle.click();
        await expect.poll(() => navigation.isVisible()).toBe(true);
        await close();
        await expect.poll(() => navigation.isVisible()).toBe(false);
      };
      await openAndClose(() => page.keyboard.press("Escape"));
      expect(await page.locator("#control-ui-main").getAttribute("inert")).toBeNull();
      await openAndClose(() => page.setViewportSize({ width: 1440, height: 900 }));
      await expect
        .poll(() => page.locator(".shell").getAttribute("class"))
        .not.toContain("shell--mobile-nav");
      held.release();
      await expect.poll(() => element.evaluate((node) => node.matches(":defined"))).toBe(true);
      await page.setViewportSize({ width: 900, height: 900 });
      await openAndClose(() => page.keyboard.press("Escape"));
      expect(errors).toEqual([]);
      expect(held.requests()).toBe(1);
    });

    it.each([
      "navigation",
      "replacement open",
      "reconnection",
      "outside pointer",
      "Escape",
    ] as const)("keeps pending Inbox intent current across %s", async (action) => {
      const { page, held } = await openHeldPage("components/sidebar-attention-panel.runtime.tsx", {
        pathname: "new",
      });
      const attention = await page
        .locator("openclaw-app-sidebar openclaw-sidebar-attention")
        .elementHandle();
      expect(attention).not.toBeNull();
      const inbox = page.locator("openclaw-app-sidebar .sidebar-issues-button");
      const dialog = page.getByRole("dialog", { name: "Inbox" });
      await inbox.click();
      const moduleUrl = await held.request;
      expect(await dialog.count()).toBe(0);
      if (action === "reconnection") {
        await attention!.evaluate(async (element) => {
          const parent = element.parentNode!;
          const next = element.nextSibling;
          element.remove();
          // Cross the bridge's move-preserving turn before reconnecting.
          await Promise.resolve();
          parent.insertBefore(element, next);
        });
      } else if (action === "outside pointer") {
        await page.locator(".new-session-page__message").click();
      } else if (action === "Escape") {
        await page.keyboard.press("Escape");
      } else {
        const toggle = page.locator('[data-navigation-view="sessions"]');
        await toggle.click();
        await expect.poll(() => page.locator(".sidebar-shell").isVisible()).toBe(false);
        // No outside pointer: a stale import must not resurrect Inbox.
        await page.evaluate(() => {
          window.dispatchEvent(new CustomEvent("openclaw:native-toggle-sidebar"));
        });
        await expect.poll(() => page.locator(".sidebar-shell").isVisible()).toBe(true);
        if (action === "replacement open") {
          await inbox.click();
        }
      }
      held.release();
      // Keep the import native: Vitest rewrites imports inside serialized callbacks.
      await page.evaluate(`import(${JSON.stringify(moduleUrl)}).then(() => undefined)`);
      await attention!.evaluate(
        (element) => (element as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete,
      );
      if (action !== "replacement open") {
        expect(await dialog.count()).toBe(0);
        expect(await inbox.getAttribute("aria-expanded")).toBe("false");
        await inbox.click();
      }
      await dialog.waitFor({ state: "visible" });
      await expect
        .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
        .toBe(true);
      expect(held.requests()).toBe(1);
      await page.keyboard.press("Escape");
      await expect.poll(() => dialog.count()).toBe(0);
    });

    it("keeps overlay motion anchored to its owning interaction", async () => {
      const { page, held: popupModule } = await openHeldPage("components/solid/tooltip.tsx", {
        nativeNav: false,
      });
      await page.keyboard.press("ControlOrMeta+K");
      // The loading dialog is replaced during handoff; measure the full palette.
      const palette = page.locator("openclaw-command-palette .cmd-palette");
      await palette.locator(".cmd-palette__input:not([disabled])").waitFor({ state: "visible" });
      await expectAnimation(palette, "animationName", "none");
      await expectAnimation(
        page.locator("openclaw-command-palette openclaw-modal-dialog.palette dialog"),
        "animationDuration",
        "0s",
      );
      await page.keyboard.press("Escape");
      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.locator(".sidebar-identity-card").click();
      const buildLink = sidebar.getByRole("menuitem", {
        name: "Control UI build details",
        exact: true,
      });
      const surface = sidebar.locator(
        "openclaw-sidebar-build-chip openclaw-tooltip .tooltip-surface[popover]",
      );
      await surface.waitFor({ state: "attached" });
      // Pause native motion before releasing the first-use renderer.
      await surface.evaluate((element) => {
        (element as HTMLElement).style.animationPlayState = "paused";
      });
      await page.clock.install();
      expect(popupModule.requests()).toBe(0);
      await buildLink.hover();
      await page.clock.runFor(600);
      await popupModule.request;
      expect(popupModule.requests()).toBe(1);
      expect(await surface.isVisible()).toBe(false);
      popupModule.release();
      await surface.waitFor({ state: "visible" });
      expect(
        await surface.evaluate((popupSurface) => {
          if (!(popupSurface instanceof HTMLElement)) {
            throw new Error("Expected HTML hovercard");
          }
          const style = getComputedStyle(popupSurface);
          const [originX, originY] = style.transformOrigin.split(" ").map(Number.parseFloat);
          return {
            open: popupSurface.matches(":popover-open"),
            animationDuration: style.animationDuration,
            centered:
              originX > popupSurface.offsetWidth * 0.45 &&
              originX < popupSurface.offsetWidth * 0.55,
            bottom: originY > popupSurface.offsetHeight * 0.95,
            placement: popupSurface.getAttribute("data-placement"),
            playState: style.animationPlayState,
          };
        }),
      ).toMatchObject({
        open: true,
        animationDuration: "0.14s",
        playState: "paused",
        placement: expect.stringMatching(/^top(?:-|$)/u),
        centered: true,
        bottom: true,
      });
      await surface.evaluate((element) => {
        (element as HTMLElement).style.removeProperty("animation-play-state");
      });
      await page.clock.resume();
      await page.keyboard.press("Escape");
      expect(popupModule.requests()).toBe(1);

      await page.setViewportSize({ width: 900, height: 900 });
      const drawer = page.locator(".shell-nav.nav-drawer");
      await expect.poll(() => drawer.count()).toBe(1);
      await page.locator(".chat-pane__nav-toggle:visible").first().click();
      await expectAnimation(drawer, "animationName", "none");
    });
  });
}
