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
    "keeps failed-reply text on one line without resending or losing the draft at %ipx",
    async (width) => {
      await suite.withPage({ viewport: { width, height: 900 } }, async ({ page }) => {
        const sessionKey = "agent:main:main";
        const diagnostic =
          "The model provider interrupted the connection before the reply finished. The example gateway returned upstream status 502.\nRequest ID: example-7942.";
        const draft = "Can you also pull out the action items?";
        const gateway = await installMockGateway(page, {
          sessionKey,
          sessions: [
            {
              key: sessionKey,
              status: "failed",
              hasActiveRun: false,
              lastRunId: "failed-run",
              lastRunError: diagnostic,
            },
          ],
          historyMessages: [{ role: "user", content: "Check the example operation." }],
        });
        await page.goto(new URL("/chat/main", suite.server.baseUrl).href);
        const notice = page.locator(".chat-error.chat-error--reply");
        const message = notice.locator(".app-toast__message");
        const refresh = notice.getByRole("button", { name: "Refresh", exact: true });
        const dismiss = notice.getByRole("button", { name: "Dismiss error", exact: true });
        await waitForControlUiProofSurface(notice, [message, refresh, dismiss]);
        const input = page.locator(".agent-chat__input textarea");
        await input.fill(draft);
        expect(await message.textContent()).toBe(diagnostic);
        expect(await message.getAttribute("role")).toBe("alert");
        expect(await notice.evaluate((element) => element.classList.contains("app-toast"))).toBe(
          false,
        );
        expect(
          await notice
            .locator(
              "details, summary, [aria-expanded], .lazy-view-error__chevron, .lazy-view-error__detail, .app-toast__description, .report-issue-link",
            )
            .count(),
        ).toBe(0);
        expect(await notice.getByRole("button").count()).toBe(2);
        const layout = await notice.evaluate((element) => {
          const messageNode = element.querySelector<HTMLElement>(".app-toast__message")!;
          const refreshNode = element.querySelector(".chat-error__refresh")!;
          const dismissNode = element.querySelector(".chat-error__dismiss.app-toast__dismiss")!;
          const style = getComputedStyle(messageNode);
          const bounds = [messageNode, refreshNode, dismissNode].map((node) =>
            node.getBoundingClientRect(),
          );
          const centers = bounds.map((rect) => rect.y + rect.height / 2);
          return {
            whiteSpace: style.whiteSpace,
            overflow: style.overflowX,
            textOverflow: style.textOverflow,
            textHeight: bounds[0]!.height,
            lineHeight: Number.parseFloat(style.lineHeight),
            clipped: messageNode.scrollWidth > messageNode.clientWidth,
            sameRow: Math.max(...centers) - Math.min(...centers),
            ordered: bounds[0]!.right <= bounds[1]!.left && bounds[1]!.right <= bounds[2]!.left,
            contained:
              element.scrollWidth <= element.clientWidth &&
              bounds[2]!.right <= element.getBoundingClientRect().right,
          };
        });
        expect(layout).toMatchObject({
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          clipped: true,
          ordered: true,
          contained: true,
        });
        expect(layout.textHeight).toBeLessThanOrEqual(layout.lineHeight + 1);
        expect(layout.sameRow).toBeLessThanOrEqual(1);
        const reads = (await gateway.getRequests("chat.history")).length;
        await refresh.click();
        await gateway.waitForRequest("chat.history", { after: reads });
        expect(await input.inputValue()).toBe(draft);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        await dismiss.click();
        await notice.waitFor({ state: "hidden" });
        expect(await input.inputValue()).toBe(draft);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
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
