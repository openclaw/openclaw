import { describe, expect, it } from "vitest";
import {
  type createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";
import { createNativeNavPageOpener } from "./native-nav-page.test-support.ts";

export function defineNativeModuleBoundaryTests(
  suite: ReturnType<typeof createControlUiE2eSuite>,
  moduleRequest: (sourcePath: string) => RegExp,
) {
  describe("Native navigation module loading", () => {
    const openPage = createNativeNavPageOpener(suite);

    it("closes navigation while the sidebar element is still unregistered", async () => {
      const testCase = {
        module: moduleRequest("ui/src/components/app-sidebar.ts"),
        pathname: "new",
        readySelector: ".new-session-page__message",
        tag: "openclaw-app-sidebar",
      };
      let held!: Awaited<ReturnType<typeof holdModuleResponse>>;
      const errors: string[] = [];
      try {
        const page = await openPage({
          ...testCase,
          width: 900,
          beforeNavigate: async (targetPage) => {
            targetPage.on("pageerror", (error) => errors.push(error.message));
            held = await holdModuleResponse(targetPage, testCase.module);
          },
        });
        await held.request;
        const element = page.locator(testCase.tag).first();
        expect(await element.evaluate((node) => node.matches(":defined"))).toBe(false);
        const toggle = page.locator(".topbar-nav-toggle");
        const navigation = page.getByRole("dialog", { name: "Navigation" });
        await toggle.click();
        await expect.poll(() => navigation.isVisible()).toBe(true);
        await page.keyboard.press("Escape");
        await expect.poll(() => navigation.isVisible()).toBe(false);
        expect(await page.locator("#control-ui-main").getAttribute("inert")).toBeNull();

        await toggle.click();
        await expect.poll(() => navigation.isVisible()).toBe(true);
        await page.setViewportSize({ width: 1440, height: 900 });
        await expect.poll(() => navigation.isVisible()).toBe(false);
        await expect
          .poll(() => page.locator(".shell").getAttribute("class"))
          .not.toContain("shell--mobile-nav");
        expect(errors).toEqual([]);

        held.release();
        await expect.poll(() => element.evaluate((node) => node.matches(":defined"))).toBe(true);
        await page.setViewportSize({ width: 900, height: 900 });
        await toggle.click();
        await expect.poll(() => navigation.isVisible()).toBe(true);
        await page.keyboard.press("Escape");
        await expect.poll(() => navigation.isVisible()).toBe(false);
        expect(errors).toEqual([]);
        expect(held.requests()).toBe(1);
      } finally {
        held?.release();
      }
    });

    it.each([
      "navigation",
      "replacement open",
      "reconnection",
      "outside pointer",
      "Escape",
    ] as const)("keeps pending Inbox intent current across %s", async (action) => {
      let held!: Awaited<ReturnType<typeof holdModuleResponse>>;
      const page = await openPage({
        pathname: "new",
        beforeNavigate: async (targetPage) => {
          held = await holdModuleResponse(
            targetPage,
            moduleRequest("ui/src/components/sidebar-attention-panel.runtime.ts"),
          );
        },
      });
      const attention = await page
        .locator("openclaw-app-sidebar openclaw-sidebar-attention")
        .elementHandle();
      expect(attention).not.toBeNull();
      const inbox = page.locator("openclaw-app-sidebar .sidebar-issues-button");
      const dialog = page.getByRole("dialog", { name: "Inbox" });
      try {
        await inbox.click();
        const moduleUrl = await held.request;
        expect(await dialog.count()).toBe(0);
        if (action === "reconnection") {
          await attention!.evaluate((element) => {
            const parent = element.parentNode!;
            const next = element.nextSibling;
            element.remove();
            parent.insertBefore(element, next);
          });
        } else if (action === "outside pointer") {
          await page.locator(".new-session-page__message").click();
        } else if (action === "Escape") {
          await page.keyboard.press("Escape");
        } else {
          await page.getByRole("button", { name: "Collapse sidebar" }).click();
          await expect
            .poll(() => page.getByRole("button", { name: "Expand sidebar" }).isVisible())
            .toBe(true);
          // The native event does not generate an outside pointer that could
          // accidentally dismiss an Inbox resurrected by the old import.
          await page.evaluate(() => {
            window.dispatchEvent(new CustomEvent("openclaw:native-toggle-sidebar"));
          });
          await expect
            .poll(() => page.getByRole("button", { name: "Collapse sidebar" }).isVisible())
            .toBe(true);
          if (action === "replacement open") {
            await inbox.click();
          }
        }
        held.release();
        // Keep the import native: Vitest rewrites imports inside serialized callbacks.
        await page.evaluate(`import(${JSON.stringify(moduleUrl)}).then(() => undefined)`);
        await attention!.evaluate(
          (element) =>
            (element as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete,
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
      } finally {
        held.release();
      }
    });

    it("keeps overlay motion anchored to its owning interaction", async () => {
      let popupModule!: Awaited<ReturnType<typeof holdModuleResponse>>;
      const page = await openPage({
        nativeNav: false,
        beforeNavigate: async (nextPage) => {
          popupModule = await holdModuleResponse(
            nextPage,
            moduleRequest("node_modules/@awesome.me/webawesome/dist/components/tooltip/tooltip.js"),
          );
        },
      });

      await page.keyboard.press("ControlOrMeta+K");
      // The loading dialog is replaced during handoff; measure the full palette.
      const palette = page.locator("openclaw-command-palette .cmd-palette");
      const paletteDialog = page.locator("openclaw-command-palette openclaw-modal-dialog.palette");
      await palette.locator(".cmd-palette__input:not([disabled])").waitFor({ state: "visible" });
      const paletteAnimationName = await palette.evaluate(
        (element) => getComputedStyle(element).animationName,
      );
      const paletteDialogAnimationDuration = await paletteDialog.evaluate((element) => {
        const webAwesomeDialog = element.shadowRoot?.querySelector("wa-dialog");
        const dialog = webAwesomeDialog?.shadowRoot?.querySelector<HTMLElement>('[part~="dialog"]');
        return dialog ? getComputedStyle(dialog).animationDuration : "missing";
      });
      await page.keyboard.press("Escape");

      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.locator(".sidebar-identity-card").click();
      const buildLink = sidebar.getByRole("menuitem", {
        name: "Control UI build details",
        exact: true,
      });
      await page.clock.install();
      await buildLink.hover();
      await page.clock.runFor(600);
      // The hover delay starts the lazy popup load; it does not finish its upgrade
      // or positioning. Keep that load pending until after the timer has elapsed.
      await popupModule.request;
      popupModule.release();
      await sidebar
        .locator(
          'openclaw-sidebar-build-chip openclaw-tooltip wa-tooltip[open] wa-popup[data-current-placement] [part~="popup"]',
        )
        .waitFor({ state: "visible" });
      const hoverCardMotion = await sidebar
        .locator("openclaw-sidebar-build-chip openclaw-tooltip")
        .evaluate((tooltip) => {
          const webAwesomeTooltip = tooltip.shadowRoot?.querySelector("wa-tooltip");
          const popup = webAwesomeTooltip?.shadowRoot?.querySelector("wa-popup");
          const popupSurface = popup?.shadowRoot?.querySelector<HTMLElement>('[part~="popup"]');
          if (!popup || !popupSurface) {
            throw new Error("expected the open sidebar hovercard shadow parts");
          }
          const [originX, originY] = getComputedStyle(popupSurface)
            .transformOrigin.split(" ")
            .map(Number.parseFloat);
          return {
            animationDuration: getComputedStyle(popupSurface).animationDuration,
            popupHeight: popupSurface.offsetHeight,
            popupWidth: popupSurface.offsetWidth,
            originX,
            originY,
            placement: popup.getAttribute("data-current-placement"),
          };
        });
      await page.clock.resume();
      await page.keyboard.press("Escape");

      await page.setViewportSize({ width: 900, height: 900 });
      const drawer = page.locator(".shell-nav.nav-drawer");
      await expect.poll(() => drawer.count()).toBe(1);
      await page.locator(".chat-pane__nav-toggle:visible").first().click();
      const drawerAnimationName = await drawer.evaluate(
        (element) => getComputedStyle(element).animationName,
      );

      expect(paletteAnimationName).toBe("none");
      expect(paletteDialogAnimationDuration).toBe("0s");
      expect(drawerAnimationName).toBe("none");
      expect(hoverCardMotion.animationDuration).toBe("0.14s");
      expect(hoverCardMotion.placement).toMatch(/^top(?:-|$)/u);
      expect(hoverCardMotion.originX).toBeGreaterThan(hoverCardMotion.popupWidth * 0.45);
      expect(hoverCardMotion.originX).toBeLessThan(hoverCardMotion.popupWidth * 0.55);
      expect(hoverCardMotion.originY).toBeGreaterThan(hoverCardMotion.popupHeight * 0.95);
    });
  });
}
