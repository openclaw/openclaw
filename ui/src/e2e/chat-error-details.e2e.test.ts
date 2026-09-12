import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI chat error details" });

async function captureDiagnosticProof(page: Page, name: string) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
    await page.screenshot({ path: path.join(suite.artifactDir, `${name}.png`), fullPage: false });
  }
}

suite.define(() => {
  it.each(["live", "history"] as const)(
    "keeps diagnostic paths and lets the operator expand and copy a complete failed run from %s",
    async (source) => {
      await suite.withPage(
        {
          viewport: { height: 900, width: 1280 },
          permissions: ["clipboard-read", "clipboard-write"],
        },
        async ({ page: currentPage }) => {
          const sessionKey = "agent:main:main";
          const skillPath =
            "/home/operator/.openclaw/projects/0123456789abcdef/example/.agents/skills/review";
          const diagnostic = `Failed to prepare skill resources: skill="review" root="${skillPath}" error=Skill trees cannot contain links or special files: path="CLAUDE.md" kind=symlink. | INVALID_BUNDLE.\npassword=synthetic-password`;
          const displayPrefix = source === "live" ? "Error: " : "This turn did not run: ";
          const safeDiagnostic =
            displayPrefix +
            diagnostic.replace("password=synthetic-password", "password=[redacted]");
          const gateway = await installMockGateway(currentPage, {
            sessionKey,
            ...(source === "history"
              ? {
                  historyMessages: [
                    {
                      role: "custom",
                      customType: "run-failed-before-reply",
                      content: displayPrefix + diagnostic,
                      __openclaw: { id: "failure-notice", seq: 1, runId: "failed-run" },
                    },
                  ],
                  sessionInfo: {
                    key: sessionKey,
                    kind: "direct",
                    status: "failed",
                    hasActiveRun: false,
                    lastRunId: "failed-run",
                    lastRunError: diagnostic.slice(0, 160),
                  },
                }
              : {}),
          });
          await currentPage.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          if (source === "live") {
            await currentPage
              .locator(".agent-chat__input textarea")
              .fill("Inspect the project skills");
            await currentPage.getByRole("button", { name: "Send message" }).click();
            const send = await gateway.waitForRequest("chat.send");
            expect(send.params).toMatchObject({ sessionKey, idempotencyKey: expect.any(String) });
            const { idempotencyKey: runId } = send.params as { idempotencyKey: string };
            await gateway.emitGatewayEvent("chat", {
              sessionKey,
              runId,
              state: "error",
              errorMessage: diagnostic,
            });
          } else {
            await gateway.waitForRequest("chat.startup");
          }
          const alert = currentPage.locator(".chat-error");
          await alert.waitFor();
          await captureDiagnosticProof(currentPage, `run-error-${source}-collapsed`);
          const summary = alert.locator("summary");
          expect(await summary.count()).toBe(1);
          await summary.focus();
          await summary.press("Enter");
          const details = alert.getByLabel("Error details", { exact: true });
          await expect.poll(() => details.isVisible()).toBe(true);
          await captureDiagnosticProof(currentPage, `run-error-${source}-expanded`);
          expect(await details.textContent()).toBe(safeDiagnostic);
          const copy = alert.getByRole("button", { name: "Copy error", exact: true });
          await copy.click();
          await expect
            .poll(() => currentPage.evaluate(() => navigator.clipboard.readText()))
            .toBe(safeDiagnostic);
          expect(await details.isVisible()).toBe(true);
          await currentPage.setViewportSize({ width: 393, height: 852 });
          await expect
            .poll(() =>
              currentPage
                .locator(".sidebar")
                .evaluate(
                  (node) =>
                    !node.checkVisibility({ checkOpacity: true }) ||
                    node.getBoundingClientRect().right <= 0,
                ),
            )
            .toBe(true);
          await expect
            .poll(() => alert.evaluate((node) => node.scrollWidth <= node.clientWidth))
            .toBe(true);
          await captureDiagnosticProof(currentPage, `run-error-${source}-mobile`);
          await summary.press("Enter");
          await expect.poll(() => details.isVisible()).toBe(false);
        },
      );
    },
  );
});
