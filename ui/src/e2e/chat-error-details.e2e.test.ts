import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { assert, expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI chat error details" });

async function captureDiagnosticProof(page: Page, name: string) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
    await page.screenshot({
      path: path.join(suite.artifactDir, `${name}.png`),
      fullPage: false,
      animations: "disabled",
    });
  }
}

suite.define(() => {
  it.each(["failed", "timeout"] as const)(
    "shows a %s diagnostic when only the terminal session update arrives",
    async (status) => {
      await suite.withPage({ viewport: { height: 900, width: 1280 } }, async ({ page }) => {
        const sessionKey = "agent:main:main";
        const diagnostic = "The configured model is unavailable. Select another model and retry.";
        const gateway = await installMockGateway(page, { sessionKey });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await page.locator(".agent-chat__input textarea").fill("Review the project");
        await page.getByRole("button", { name: "Send message" }).click();
        const send = await gateway.waitForRequest("chat.send");
        assert(isRecord(send.params) && typeof send.params.idempotencyKey === "string");
        const runId = send.params.idempotencyKey;
        await page.getByRole("button", { name: "Stop generating" }).waitFor();
        const row = {
          key: sessionKey,
          kind: "direct",
          updatedAt: Date.now(),
          endedAt: Date.now(),
          hasActiveRun: false,
          activeRunIds: [],
          lastRunId: runId,
          status,
          lastRunError: diagnostic,
        };
        await gateway.setSessionsListResponse({
          sessions: [row],
          count: 1,
          path: "",
          ts: row.updatedAt,
          defaults: { model: "gpt-5.5", modelProvider: "openai", contextTokens: null },
        });
        // Deliberately omit chat.error: the canonical session update must be sufficient.
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey,
          agentId: "main",
          runId,
          reason: "lifecycle",
          phase: "error",
          session: row,
        });
        await page.getByRole("button", { name: "Stop generating" }).waitFor({ state: "hidden" });
        await captureDiagnosticProof(page, `run-error-session-${status}`);
        const alert = page.locator(".chat-error");
        await expect.poll(() => alert.textContent()).toContain(diagnostic);
        expect(await alert.getByRole("button", { name: "Copy error", exact: true }).count()).toBe(
          1,
        );
        await page.locator(".agent-chat__input textarea").fill("Try again");
        await page.getByRole("button", { name: "Send message" }).click();
        await gateway.waitForRequest("chat.send", { after: 1 });
        await expect.poll(() => alert.count()).toBe(0);
      });
    },
  );

  it("keeps a rejected session-change message visible with recovery guidance and diagnostic details", async () => {
    await suite.withPage(
      {
        viewport: { height: 900, width: 1280 },
        permissions: ["clipboard-read", "clipboard-write"],
      },
      async ({ page }) => {
        const sessionKey = "agent:main:main";
        const prompt = "Continue reviewing the example project";
        const diagnostic = `DispatchSessionRefreshRequiredError: Session "${sessionKey}" changed while starting work. Retry.`;
        const recovery =
          "Your message didn't run because the conversation changed. Refresh the conversation, then send it again.";
        const errorMessage = `${recovery}\n\n${diagnostic}`;
        const gateway = await installMockGateway(page, { sessionKey });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await page.locator(".agent-chat__input textarea").fill(prompt);
        await page.getByRole("button", { name: "Send message" }).click();
        const send = await gateway.waitForRequest("chat.send");
        assert(isRecord(send.params) && typeof send.params.idempotencyKey === "string");
        const runId = send.params.idempotencyKey;
        await gateway.setHistoryMessages([
          {
            role: "user",
            content: prompt,
            __openclaw: {
              id: "rejected-input",
              seq: 1,
              idempotencyKey: `${runId}:user`,
            },
          },
        ]);
        await gateway.emitGatewayEvent("chat", {
          sessionKey,
          runId,
          state: "error",
          errorMessage,
        });
        const alert = page.locator(".chat-error");
        await alert.waitFor();
        await captureDiagnosticProof(page, "session-change-collapsed");
        expect(await alert.locator("summary strong").textContent()).toBe(`Error: ${recovery}`);
        expect(await page.locator(".chat-thread").textContent()).toContain(prompt);
        await alert.locator("summary").click();
        const details = alert.getByLabel("Error details", { exact: true });
        await expect.poll(() => details.isVisible()).toBe(true);
        expect(await details.textContent()).toBe(`Error: ${errorMessage}`);
        await alert.getByRole("button", { name: "Copy error", exact: true }).click();
        await expect
          .poll(() => page.evaluate(() => navigator.clipboard.readText()))
          .toBe(`Error: ${errorMessage}`);
        await captureDiagnosticProof(page, "session-change-expanded");
        await page.setViewportSize({ width: 393, height: 852 });
        await expect
          .poll(() =>
            page
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
        await captureDiagnosticProof(page, "session-change-mobile");
        await alert.locator("summary").click();
        await captureDiagnosticProof(page, "session-change-mobile-collapsed");
        const input = page.locator(".agent-chat__input textarea");
        await input.fill("A newer draft stays here");
        const historyCount = (await gateway.getRequests("chat.history")).length;
        await alert.getByRole("button", { name: "Refresh", exact: true }).click();
        await gateway.waitForRequest("chat.history", { after: historyCount });
        expect(await input.inputValue()).toBe("A newer draft stays here");
        expect(await page.locator(".chat-thread").textContent()).toContain(prompt);
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      },
    );
  });

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
