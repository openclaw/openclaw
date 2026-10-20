import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
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
  it("renders the dev checkout branch in the footer in the danger color", async () => {
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

      const colors = await badge.evaluate((element) => {
        // Resolve the token before comparing against the computed RGB color.
        const probe = document.createElement("span");
        probe.style.color = "var(--danger)";
        element.append(probe);
        const danger = getComputedStyle(probe).color;
        probe.remove();
        return { badge: getComputedStyle(element).color, danger };
      });
      expect(colors.danger).not.toBe("");
      expect(colors.badge).toBe(colors.danger);
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
        await installMockGateway(page, { sessionKey: sessions[0]!.key, sessions });
        await page.emulateMedia({ colorScheme: "dark" });
        const response = await page.goto(suite.server.baseUrl);
        expect(response?.status()).toBe(200);
        if (viewport.hasTouch) {
          await page
            .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
            .first()
            .click();
        }
        const sidebar = page.locator("openclaw-app-sidebar .sidebar");
        const body = sidebar.locator(".sidebar-shell__body");
        await body.waitFor();
        await sidebar.locator(".sidebar-identity-card").waitFor();
        await sidebar.getByRole("button", { name: "Show more", exact: true }).click();
        await sidebar.getByText("CI timer", { exact: true }).waitFor();
        await takeControlUiScreenshotFrame(page, sidebar, [body], {
          animations: "disabled",
          scrollTo: sidebar.getByText("CI timer", { exact: true }),
          elements: [sidebar],
        });
        const gap = await body.evaluate((element) => {
          const shell = element.closest(".sidebar-shell")!;
          const style = getComputedStyle(shell);
          return (
            shell.getBoundingClientRect().bottom -
            element.getBoundingClientRect().bottom -
            Number.parseFloat(style.paddingBottom)
          );
        });
        expect(gap).toBeLessThanOrEqual(1);
        expect(await sidebar.locator(".sidebar-footer-branch").count()).toBe(0);
      },
    );
  });
});
