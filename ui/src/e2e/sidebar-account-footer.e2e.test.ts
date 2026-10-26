import { expect, it } from "vitest";
import type { ControlUiBuildInfo } from "../build-info.ts";
import { expectPath } from "./sidebar-assertions.test-support.ts";
import {
  captureUnionProof,
  createSidebarFooterProofSuite,
  openSidebarFooterProofPage,
} from "./sidebar-footer-proof.test-support.ts";

const featureBuild: ControlUiBuildInfo = {
  version: "2026.8.14",
  commit: "0123456789abcdef0123456789abcdef01234567",
  commitAt: "2026-08-14T12:00:00.000Z",
  builtAt: "2026-08-14T12:00:00.000Z",
  branch: "feat/sidebar-footer",
  dirty: false,
  release: false,
  buildId: "sidebar-account-footer-feat-sidebar-footer",
};

const suite = createSidebarFooterProofSuite("Control UI sidebar build navigation", featureBuild);

suite.define(() => {
  it("navigates from the build link without opening its hovercard on click", async () => {
    const { page, sidebar, context } = await openSidebarFooterProofPage(suite, {
      serverVersion: featureBuild.version ?? undefined,
      serverBuildId: featureBuild.buildId,
    });
    try {
      await sidebar.locator(".sidebar-identity-card").click();
      const buildLink = sidebar.getByRole("menuitem", {
        name: "Control UI build details",
        exact: true,
      });
      const tooltip = sidebar.locator("openclaw-sidebar-build-chip openclaw-tooltip");
      const surface = tooltip.locator(".tooltip-surface[popover]");
      await buildLink.hover();
      await expect
        .poll(() => surface.evaluate((element) => element.matches(":popover-open")))
        .toBe(true);
      await captureUnionProof(suite, page, "sidebar-account-footer", "build-hover.png", [
        sidebar.locator(".sidebar-build-hover-card"),
      ]);
      await page.mouse.move(0, 0);
      await sidebar.locator(".sidebar-build-hover-card").waitFor({ state: "hidden" });
      await tooltip.evaluate((element) => {
        document.documentElement.dataset.buildTooltipOpenedByClick = "false";
        element.addEventListener(
          "overlay-show",
          () => {
            document.documentElement.dataset.buildTooltipOpenedByClick = "true";
          },
          { once: true },
        );
      });
      await buildLink.click();
      await expectPath(page, "/settings/about");
      expect(await page.locator("html").getAttribute("data-build-tooltip-opened-by-click")).toBe(
        "false",
      );
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
