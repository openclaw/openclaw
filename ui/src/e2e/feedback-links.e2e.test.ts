import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI feedback links",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => "Playwright Chromium is unavailable at " + executablePath,
});

suite.define(() => {
  it("opens the appropriate public issue template without attaching runtime data", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    await installMockGateway(page);
    try {
      await page.goto(suite.server.baseUrl);
      await page.locator(".sidebar-identity-card").click();
      await page.getByRole("menuitem", { name: "Help", exact: true }).click();
      await page.getByRole("menuitem", { name: "Docs", exact: true }).waitFor({ state: "visible" });
      const proofDir = process.env.OPENCLAW_FEEDBACK_PROOF_DIR;
      if (proofDir) {
        await mkdir(proofDir, { recursive: true });
        await page.screenshot({
          path: path.join(proofDir, "help-menu.png"),
          animations: "disabled",
        });
      }
      const report = page.getByRole("menuitem", { name: "Report a bug", exact: true });
      await report.waitFor({ state: "visible" });
      // Block the external navigation: this proof never sends a request to GitHub.
      await context.route("https://github.com/**", (route) =>
        route.fulfill({ body: "Issue form destination verified" }),
      );
      const popupPromise = page.waitForEvent("popup");
      await report.click();
      const popup = await popupPromise;
      await popup.waitForLoadState();
      const url = new URL(popup.url());
      expect(url.origin + url.pathname).toBe("https://github.com/openclaw/openclaw/issues/new");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        template: "bug_report.yml",
        title: "[Bug]: Control UI: ",
      });
      expect(await popup.evaluate(() => window.opener)).toBeNull();
      expect(await popup.evaluate(() => document.referrer)).toBe("");
    } finally {
      await context.close();
    }
  });
  it("offers a safe report link after connection authentication fails", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        connect: {
          __mockError: {
            code: "INVALID_REQUEST",
            message: "Synthetic connection failure. Private details must stay in the app.",
            details: { code: "AUTH_TOKEN_MISMATCH" },
          },
        },
      },
    });
    try {
      await page.goto(suite.server.baseUrl);
      const report = page
        .locator(".login-gate")
        .getByRole("link", { name: "Report a bug", exact: true });
      await report.waitFor();
      expect(await report.getAttribute("href")).toBe(
        "https://github.com/openclaw/openclaw/issues/new?template=bug_report.yml&title=%5BBug%5D%3A%20Control%20UI%3A%20",
      );
      expect(await report.getAttribute("rel")).toBe("noopener noreferrer");
      const bugIcon = report.locator('.session-css-icon[aria-hidden="true"]');
      expect(await bugIcon.count()).toBe(1);
      expect(await bugIcon.isVisible()).toBe(true);
      const proofDir = process.env.OPENCLAW_FEEDBACK_PROOF_DIR;
      if (proofDir) {
        await mkdir(proofDir, { recursive: true });
        await page.screenshot({
          path: path.join(proofDir, "connection-error.png"),
          animations: "disabled",
        });
      }
    } finally {
      await context.close();
    }
  });
});
