import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  pauseVirtualClock,
} from "../test-helpers/control-ui-e2e.ts";
import { navigationDrawerToggle } from "../test-helpers/control-ui-navigation.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI sidebar dev branch badge E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const DEV_BRANCH = "feat/dev-branch-badge";

suite.define(() => {
  it("renders the dev checkout branch and its tooltip in the footer", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await installMockGateway(page, { devGitBranch: DEV_BRANCH });

      const response = await page.goto(suite.server.baseUrl);
      expect(response?.status()).toBe(200);

      const badge = page.locator(".sidebar-footer-branch");
      await badge.waitFor();
      await expect
        .poll(() =>
          badge.evaluate((element) => {
            const id = element.getAttribute("aria-describedby");
            return {
              name: element.querySelector(".sidebar-footer-branch__name")?.textContent,
              description: id ? (document.getElementById(id)?.textContent ?? null) : null,
            };
          }),
        )
        .toEqual({ name: DEV_BRANCH, description: DEV_BRANCH });
    });
  });

  it.each([
    { name: "desktop", width: 1280, height: 800, hasTouch: false },
    { name: "mobile", width: 390, height: 844, hasTouch: true },
  ])("returns unused footer space to the session pane on $name", async (viewport) => {
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), viewport, hasTouch: viewport.hasTouch },
      async ({ page }) => {
        const sessions = Array.from({ length: 20 }, (_, index) => ({
          key: `agent:main:review-${index}`,
          kind: "direct",
          label: index === 19 ? "CI timer" : `Release review ${index + 1}`,
          updatedAt: 1_780_000_000_000 - index * 60_000,
        }));
        const gateway = await installMockGateway(page, { sessionKey: sessions[0]!.key, sessions });
        await page.emulateMedia({ colorScheme: "dark" });
        const response = await page.goto(suite.server.baseUrl);
        expect(response?.status()).toBe(200);
        if (viewport.hasTouch) {
          await navigationDrawerToggle(page).click();
        }
        const sidebar = page.locator("openclaw-app-sidebar .sidebar");
        const body = sidebar.locator(".sidebar-shell__body");
        await body.waitFor();
        await sidebar.locator(".sidebar-identity-card").waitFor();
        await sidebar.getByRole("button", { name: "Show more", exact: true }).click();
        const last = sidebar.getByText("CI timer", { exact: true });
        await expect
          .poll(async () => {
            await body.evaluate((element) => {
              element.scrollTop = element.scrollHeight;
            });
            return last.isVisible();
          })
          .toBe(true);
        await takeControlUiScreenshotFrame(page, sidebar, [body], {
          animations: "disabled",
          scrollTo: sidebar.getByText("CI timer", { exact: true }),
          elements: [sidebar],
        });
        expect(await sidebar.locator(".sidebar-shell__footer").count()).toBe(0);
        const unusedSpace = await body.evaluate((element) => {
          const shell = element.closest(".sidebar-shell")!;
          return (
            shell.getBoundingClientRect().bottom -
            element.getBoundingClientRect().bottom -
            Number.parseFloat(getComputedStyle(shell).paddingBottom)
          );
        });
        expect(Math.abs(unusedSpace)).toBeLessThanOrEqual(1);
        expect(await sidebar.locator(".sidebar-footer-branch").count()).toBe(0);
        const connectedBounds = await body.boundingBox();
        await page.clock.install();
        await pauseVirtualClock(page);
        await gateway.setOnline(false);
        await page.clock.runFor(2_001);
        const flag = sidebar.locator(".sidebar-shell__connection");
        await flag.waitFor({ state: "visible" });
        await page.clock.runFor(4_001);
        expect(await flag.isVisible()).toBe(true);
        expect(await body.boundingBox()).toEqual(connectedBounds);
        await gateway.setOnline(true);
        await page.clock.resume();
        await flag.waitFor({ state: "detached" });
        expect(await body.boundingBox()).toEqual(connectedBounds);
        await last.click();
        await expect
          .poll(() => page.url())
          .toBe(controlUiSessionUrl(suite.server.baseUrl, sessions[19]!.key));
      },
    );
  });
});
