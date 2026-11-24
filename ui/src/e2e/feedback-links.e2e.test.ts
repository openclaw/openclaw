import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
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
  it.each([
    [1280, false],
    [400, true],
  ] as const)(
    "keeps a long reply error on one line until it is opened at %ipx",
    async (width, touch) => {
      await suite.withPage(
        {
          viewport: { width, height: 800 },
          colorScheme: "light",
          ...(touch ? { hasTouch: true, isMobile: true } : {}),
        },
        async ({ page }) => {
          const sessionKey = "agent:main:main";
          const error =
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
                lastRunError: error,
              },
            ],
            historyMessages: [
              { role: "user", content: "Summarize the notes from our planning session." },
            ],
          });
          await page.goto(new URL("/chat/main", suite.server.baseUrl).href);
          const notice = page.locator(".chat-error");
          const message = notice.getByRole("alert");
          const chevron = notice.getByRole("button", { name: "Error details", exact: true });
          const refresh = notice.getByRole("button", { name: "Refresh", exact: true });
          const input = page.locator(".agent-chat__input textarea");
          await message.waitFor();
          expect(await message.textContent()).toBe(error);
          await input.fill(draft);
          await expect.poll(() => chevron.isEnabled()).toBe(true);
          const capture = async (name: string) => {
            const directory = process.env.OPENCLAW_REPLY_PROOF_DIR;
            if (directory) {
              const frame = await takeControlUiScreenshotFrame(page, notice, [message, refresh], {
                elements: [notice, message, refresh],
                animations: "disabled",
              });
              await writeFile(path.join(directory, name + "-" + width + ".png"), frame.png);
            }
          };
          const opacity = () => chevron.evaluate((element) => getComputedStyle(element).opacity);
          const closed = (await message.boundingBox())!;
          // The card is anchored above the composer, so it grows upward when opened.
          const actionsOffset = async () =>
            (await refresh.boundingBox())!.y - (await notice.boundingBox())!.y;
          const actionsTop = await actionsOffset();
          expect(closed.height).toBeLessThanOrEqual(32);
          if (touch) {
            // Touch has no hover, so the control is visible from the start.
            expect(await opacity()).toBe("1");
            await capture("closed");
            await message.tap();
          } else {
            await page.mouse.move(0, 0);
            await expect.poll(opacity).toBe("0");
            await capture("closed");
            await message.hover();
            await expect.poll(opacity).toBe("1");
            await capture("hover");
            await message.click();
          }
          await expect.poll(() => chevron.getAttribute("aria-expanded")).toBe("true");
          expect((await message.boundingBox())!.height).toBeGreaterThan(closed.height);
          expect(await actionsOffset()).toBe(actionsTop);
          expect(await notice.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
          await capture("open");
          const reads = (await gateway.getRequests("chat.history")).length;
          await refresh.click();
          await gateway.waitForRequest("chat.history", { after: reads });
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          expect(await input.inputValue()).toBe(draft);
          expect(await chevron.getAttribute("aria-expanded")).toBe("true");
          await chevron.press("Enter");
          await expect.poll(() => chevron.getAttribute("aria-expanded")).toBe("false");
          expect((await message.boundingBox())!.height).toBe(closed.height);
          await notice.getByRole("button", { name: "Dismiss error", exact: true }).click();
          await notice.waitFor({ state: "hidden" });
        },
      );
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
