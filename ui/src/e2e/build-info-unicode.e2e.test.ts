import { expect, it } from "vitest";
import { installMockGateway, startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const BUILD_ID = "build-info-unicode-e2e";

const suite = createControlUiE2eSuite({
  name: "Control UI Unicode build identity mocked Gateway E2E",
  startServer: () =>
    startControlUiE2eServer({
      version: "2026.7.10",
      commit: "0123456789abcdef0123456789abcdef01234567",
      commitAt: "2026-07-10T11:22:33.000Z",
      builtAt: "2026-07-10T12:34:56.000Z",
      branch: RAW_BRANCH,
      dirty: true,
      release: false,
      buildId: BUILD_ID,
    }),
  startServerBeforeBrowser: true,
});

const RAW_BRANCH = `${"a".repeat(12)}😀${"b".repeat(85)}😀suffix`;
const NORMALIZED_BRANCH = `${"a".repeat(12)}😀${"b".repeat(85)}`;
const COMPACT_BRANCH = `${"a".repeat(12)}😀…`;

suite.define(() => {
  it("keeps slow build-link navigation intact across Unicode boundaries and reload", async () =>
    suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await installMockGateway(page, { serverBuildId: BUILD_ID, serverVersion: "2026.7.10" });

      await page.goto(`${suite.server.baseUrl}chat`);
      await expect
        .poll(() => page.locator(".sidebar-identity-card").getAttribute("aria-label"))
        .toMatch(/: a{12}😀…@0123456\* · \S/u);
      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.getByRole("button", { name: /^Identity and app menu for / }).click();
      const buildLink = sidebar.getByRole("menuitem", {
        name: "Control UI build details",
        exact: true,
      });
      await buildLink.waitFor();
      const compactText = (await buildLink.textContent()) ?? "";
      expect(compactText).toContain(`${COMPACT_BRANCH}@0123456`);
      expect(compactText).not.toMatch(/�|[\uD800-\uDFFF]/u);

      await buildLink.hover();
      const tooltip = sidebar.locator(
        "openclaw-sidebar-build-chip openclaw-tooltip .tooltip-surface[popover]",
      );
      await expect
        .poll(() => tooltip.evaluate((element) => element.matches(":popover-open")))
        .toBe(true);
      const buildLinkHandle = await buildLink.elementHandle();
      if (!buildLinkHandle) {
        throw new Error("Expected the identity-menu build link to be attached");
      }
      const afterHideMarker = "data-openclaw-test-after-hide";
      await tooltip.evaluate((element, marker) => {
        element.addEventListener("overlay-after-hide", () => element.setAttribute(marker, ""), {
          once: true,
        });
      }, afterHideMarker);
      await page.mouse.down();
      await expect
        .poll(() =>
          tooltip.evaluate((element, marker) => element.hasAttribute(marker), afterHideMarker),
        )
        .toBe(true);
      expect(await buildLinkHandle.evaluate((element) => element.isConnected)).toBe(true);
      await page.mouse.up();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/about");
      const branch = page
        .locator(".settings-kv dt", { hasText: "Branch" })
        .locator("xpath=following-sibling::dd[1]/code");
      await expect.poll(() => branch.textContent()).toBe(`${NORMALIZED_BRANCH}*`);
      await page.reload();
      await expect.poll(() => branch.textContent()).toBe(`${NORMALIZED_BRANCH}*`);
    }));
});
