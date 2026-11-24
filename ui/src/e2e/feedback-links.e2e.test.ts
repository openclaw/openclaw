import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { waitForControlUiProofSurface } from "../test-helpers/control-ui-e2e-screenshot.ts";
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
  it.each([1280, 820, 400])(
    "keeps failed-reply copy compact with reachable feedback at %ipx",
    async (width) => {
      await suite.withPage({ viewport: { width, height: 900 } }, async ({ page, context }) => {
        const sessionKey = "agent:main:main";
        const gateway = await installMockGateway(page, {
          sessionKey,
          sessions: [
            {
              key: sessionKey,
              status: "failed",
              hasActiveRun: false,
              lastRunId: "failed-run",
              lastRunError:
                "Synthetic reply failure for layout verification.\nRetained diagnostic details.",
            },
          ],
          historyMessages: [{ role: "user", content: "Check the example operation." }],
        });
        await page.goto(new URL("/chat/main", suite.server.baseUrl).href);
        const notice = page.locator(".chat-error");
        const title = notice.locator(".app-toast__message");
        const refresh = notice.getByRole("button", { name: "Refresh", exact: true });
        const report = notice.getByRole("link", { name: "Report a bug", exact: true });
        await waitForControlUiProofSurface(notice, [title, refresh]);
        expect(await title.textContent()).toBe("Synthetic reply failure for layout verification.");
        expect(await notice.locator(".app-toast__description").count()).toBe(0);
        const collapsed = await notice.evaluate((element) => {
          const refreshNode = element.querySelector(".chat-error__refresh")!;
          return {
            height: element.getBoundingClientRect().height,
            fontSize: getComputedStyle(refreshNode).fontSize,
          };
        });
        if (width === 1280) {
          expect.soft(collapsed.height).toBeLessThanOrEqual(104);
        }
        expect(await report.isVisible()).toBe(false);
        const toggle = notice.getByRole("button", { name: "Show details", exact: true });
        expect(await toggle.count()).toBe(1);
        expect(await toggle.getAttribute("aria-expanded")).toBe("false");
        const labelStyle = await toggle.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            background: style.backgroundColor,
            border: style.borderWidth,
            outline: style.outlineStyle,
            color: style.color,
            chevron: getComputedStyle(element.querySelector(".lazy-view-error__chevron")!).color,
          };
        });
        expect.soft(labelStyle.background).toBe("rgba(0, 0, 0, 0)");
        expect.soft(labelStyle.border).toBe("0px");
        expect.soft(labelStyle.outline).toBe("none");
        expect.soft(labelStyle.chevron).not.toBe(labelStyle.color);
        await toggle.focus();
        expect(await toggle.evaluate((element) => element === document.activeElement)).toBe(true);
        expect
          .soft(await toggle.evaluate((element) => getComputedStyle(element).textDecorationLine))
          .toBe("underline");
        await toggle.press("Enter");
        await notice.getByLabel("Error details", { exact: true }).waitFor();
        await expect.poll(() => toggle.getAttribute("aria-expanded")).toBe("true");
        await report.waitFor();
        expect
          .soft(await notice.evaluate((element) => getComputedStyle(element).boxShadow))
          .toBe("none");
        expect(await report.evaluate((element) => getComputedStyle(element).fontSize)).toBe(
          collapsed.fontSize,
        );
        await context.route("https://github.com/**", (route) =>
          route.fulfill({ body: "Issue form destination verified" }),
        );
        const popupPromise = page.waitForEvent("popup");
        await report.click();
        const popup = await popupPromise;
        await popup.waitForLoadState();
        expect(new URL(popup.url()).pathname).toBe("/openclaw/openclaw/issues/new");
        await popup.close();
        expect(await toggle.getAttribute("aria-expanded")).toBe("true");
        const reads = (await gateway.getRequests("chat.history")).length;
        await refresh.click();
        await gateway.waitForRequest("chat.history", { after: reads });
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        await notice.getByRole("button", { name: "Dismiss error", exact: true }).click();
        await notice.waitFor({ state: "hidden" });
      });
    },
  );
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
