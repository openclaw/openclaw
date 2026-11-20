import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { navigationDrawerToggle } from "../test-helpers/control-ui-navigation.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { openSidebarPages } from "./sidebar-customization.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Mobile web sidebar section navigation" });
const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const phone = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  colorScheme: "dark",
  reducedMotion: "reduce",
  locale: "en-US",
} as const;

suite.define(() => {
  it("keeps the Systems list open and still dismisses destination pages", () =>
    suite.withPage(phone, async ({ page }) => {
      await installMockGateway(page, {
        methodResponses: {
          "backup.status": { targets: [], schedules: [], locations: [] },
          "environments.list": {
            environments: [
              { id: "gateway", type: "local", label: "Gateway machine", status: "available" },
              { id: "worker", type: "worker", label: "Cloud worker", status: "available" },
            ],
          },
        },
      });
      await page.goto(suite.server.baseUrl + "chat");
      const toggle = navigationDrawerToggle(page);
      await toggle.tap();
      await (
        await openSidebarPages(page)
      )
        .getByRole("link", { name: "Systems", exact: true })
        .tap();
      await waitForControlUiRoute(page, { routeId: "systems" });
      if (capture) {
        await writeFile(
          path.join(suite.artifactDir, `${process.env.OPENCLAW_PROOF_STAGE ?? "proof"}.png`),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [toggle]),
        );
      }
      expect(await toggle.getAttribute("aria-expanded")).toBe("true");
      await page.locator('[data-navigation-view="sessions"]').click();
      const worker = page.locator(".systems-sidebar").getByRole("button", { name: /Cloud worker/ });
      await worker.tap();
      await expect.poll(() => worker.getAttribute("aria-pressed")).toBe("true");

      await page.keyboard.press("Escape");
      await page.locator(".systems-page-header").waitFor();
      expect(await toggle.getAttribute("aria-expanded")).toBe("false");
      await toggle.tap();
      await (await openSidebarPages(page)).getByRole("link", { name: "Usage", exact: true }).tap();
      await waitForControlUiRoute(page, { routeId: "usage" });
      expect(await toggle.getAttribute("aria-expanded")).toBe("false");
    }));
});
