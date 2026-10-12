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
  it("keeps restored startup diagnostics behind details", async () => {
    await suite.withPage({ viewport: { height: 900, width: 1280 } }, async ({ page }) => {
      const sessionKey = "agent:main:main";
      const content =
        "Conversation context is unavailable. Refresh and try again. If it still fails, start a new conversation with the context you need.";
      const diagnostic = "thread not loaded: synthetic-thread";
      await installMockGateway(page, {
        sessionKey,
        historyMessages: [
          {
            role: "custom",
            customType: "run-failed-before-reply",
            content,
            details: { diagnostic },
            __openclaw: { id: "failure-notice", seq: 1, runId: "failed-run" },
          },
        ],
        sessionInfo: {
          key: sessionKey,
          kind: "direct",
          status: "failed",
          hasActiveRun: false,
          lastRunId: "failed-run",
          lastRunError: content,
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const alert = page.locator(".chat-error");
      await alert.waitFor();
      await expect
        .poll(() => alert.locator(".chat-composer-neighbor-card__copy span").isVisible())
        .toBe(true);
      expect(await page.getByText(diagnostic, { exact: true }).isVisible()).toBe(false);
      await alert.locator("summary").click();
      expect(await alert.getByLabel("Error details", { exact: true }).textContent()).toContain(
        diagnostic,
      );
    });
  });

  it("keeps startup recovery visible for request errors in the topbar", async () => {
    await suite.withPage({ viewport: { height: 900, width: 1280 } }, async ({ page }) => {
      const sessionKey = "agent:main:main";
      await installMockGateway(page, { sessionKey });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await page.locator(".agent-chat__input textarea").waitFor();
      // Inject the notice state to verify the topbar's production CSS, independently
      // of which request owner reports the startup failure.
      await page.locator(".chat-pane-cache__pane--visible").evaluate((element) => {
        const pane = element as HTMLElement & {
          state?: { lastError: string | null };
          requestUpdate: () => void;
        };
        if (!pane.state) {
          throw new Error("Expected the visible chat pane's state");
        }
        pane.state.lastError = "thread not loaded: synthetic-thread";
        pane.requestUpdate();
      });
      const alert = page.locator(".chat-topbar-notices .chat-error");
      await alert.waitFor();
      const guidance = alert.getByText("Refresh and try again.", { exact: false });
      await expect.poll(() => guidance.isVisible()).toBe(true);
      await captureDiagnosticProof(page, "startup-request-context");
    });
  });

  it.each([
    [
      "thread not loaded: synthetic-thread",
      "Conversation context is unavailable.",
      "Refresh and try again.",
    ],
    [
      "managed worktree allocation lease core:managed-worktrees:create/capacity was lost",
      "Workspace preparation was interrupted.",
      "Refresh to check its status before trying again.",
    ],
  ])(
    "shows recovery before opening details for startup failure: %s",
    async (diagnostic, title, guidance) => {
      await suite.withPage({ viewport: { height: 900, width: 1280 } }, async ({ page }) => {
        const sessionKey = "agent:main:main";
        const gateway = await installMockGateway(page, { sessionKey });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const input = page.locator(".agent-chat__input textarea");
        await input.fill("Continue the example project");
        await page.getByRole("button", { name: "Send message" }).click();
        const send = await gateway.waitForRequest("chat.send");
        assert(isRecord(send.params) && typeof send.params.idempotencyKey === "string");
        await gateway.emitGatewayEvent("chat", {
          sessionKey,
          runId: send.params.idempotencyKey,
          state: "error",
          errorMessage: diagnostic,
        });
        const alert = page.locator(".chat-error");
        await alert.waitFor();
        await captureDiagnosticProof(
          page,
          title.startsWith("Conversation") ? "startup-context" : "startup-workspace",
        );
        expect(await alert.textContent()).toContain(title);
        await expect.poll(() => alert.getByText(guidance, { exact: false }).isVisible()).toBe(true);
        expect(await alert.getByRole("button", { name: "Retry", exact: true }).count()).toBe(0);
        await alert.locator("summary").click();
        expect(await alert.getByLabel("Error details", { exact: true }).textContent()).toContain(
          diagnostic,
        );
        await alert.locator("summary").click();
        await input.fill("Keep this draft");
        const historyCount = (await gateway.getRequests("chat.history")).length;
        await alert.getByRole("button", { name: "Refresh", exact: true }).click();
        await gateway.waitForRequest("chat.history", { after: historyCount });
        expect(await input.inputValue()).toBe("Keep this draft");
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      });
    },
  );

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
        expect(await alert.locator("summary strong").textContent()).toBe(
          "Couldn't finish this reply. Check the conversation before trying again.",
        );
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
          expect(await summary.textContent()).toContain(
            "Check the conversation before trying again.",
          );
          expect(await summary.textContent()).not.toContain(skillPath);
          expect(await summary.textContent()).not.toContain("INVALID_BUNDLE");
          expect(await alert.getByLabel("Error details", { exact: true }).isVisible()).toBe(false);
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
