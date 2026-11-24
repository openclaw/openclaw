import { writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page, Locator } from "playwright";
import { assert, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { exactButton } from "./chat-presentation.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI chat error details" });
const sessionKey = "agent:main:main";

const diagnosticContext = {
  viewport: { height: 900, width: 1280 },
};

async function sendPrompt(
  page: Page,
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  prompt: string,
) {
  await page.locator(".agent-chat__input textarea").fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
  const { params } = await gateway.waitForRequest("chat.send");
  assert(isRecord(params) && typeof params.idempotencyKey === "string");
  return { params, runId: params.idempotencyKey };
}

async function expectMobileFit(page: Page, alert: Locator) {
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
}

suite.define(() => {
  it("preserves bounded OAuth facts in the full reply error without disclosure", async () => {
    await suite.withPage(diagnosticContext, async ({ page }) => {
      const gateway = await installMockGateway(page, { sessionKey, historyMessages: [] });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const { runId } = await sendPrompt(page, gateway, "Check the example connection.");
      const message =
        "Your refresh token has already been used to generate a new access token. Please try signing in again.";
      const diagnostic =
        message +
        "\n\nProvider: openai\nHTTP status: 401\nReason: refresh_token_reused\nType: invalid_request_error";
      await gateway.emitGatewayEvent("chat", {
        sessionKey,
        runId,
        seq: 1,
        state: "error",
        errorMessage: message,
        errorDetail: {
          provider: "openai",
          httpStatus: 401,
          failoverReason: "refresh_token_reused",
          providerRuntimeFailureKind: "auth_refresh",
          providerErrorType: "invalid_request_error",
          providerErrorMessagePreview: '{"access_token":"synthetic-oauth-response"}',
        },
      });
      const notice = page.locator(".chat-error--reply");
      const detail = notice.locator(".app-toast__message");
      await detail.waitFor();
      expect(await detail.textContent()).toBe(diagnostic);
      expect(await notice.textContent()).not.toContain("synthetic-oauth-response");
      expect(
        await notice
          .locator("details, [aria-expanded], .lazy-view-error__detail, .report-issue-link")
          .count(),
      ).toBe(0);
      await notice.getByRole("button", { name: "Open Models", exact: true }).waitFor();
      expect(await notice.getByRole("button", { name: "Refresh", exact: true }).count()).toBe(0);
      await expectMobileFit(page, notice);
      expect(await detail.textContent()).toBe(diagnostic);
    });
  });

  it("keeps startup failure guidance visible without inventing recovery activity", async () => {
    await suite.withPage(diagnosticContext, async ({ page }) => {
      const runId = "workspace-startup-failure";
      const summary = "The request was interrupted because OpenClaw storage is busy.";
      await installMockGateway(page, {
        sessionKey,
        historyMessages: [
          {
            role: "user",
            content: "Help me plan today's work.",
            timestamp: 1,
            __openclaw: { id: "startup-user", seq: 1, runId },
          },
          {
            role: "custom",
            customType: "run-failed-before-reply",
            content: "Your request couldn't be completed.",
            display: true,
            timestamp: 2,
            openclawRunError: {
              runId,
              summary: "Your request couldn't be completed.",
              desktopSummary: summary,
            },
            __openclaw: { id: "startup-failure", seq: 2, runId },
          },
        ],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const notice = page.locator(".chat-run-failure");
      await notice.locator(".chat-run-failure__toggle").click();
      const details = notice.locator(".chat-run-failure__log");
      await details.waitFor();
      expect(await details.textContent()).toBe(summary);
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const directory = createControlUiE2eArtifactDir("startup-failure");
        const frame = await takeControlUiScreenshotFrame(page, page.locator(".shell"), [details], {
          animations: "disabled",
        });
        await writeFile(path.join(directory, "startup-failure.png"), frame.png);
      }
      expect(await notice.locator(".chat-run-failure__summary").count()).toBe(0);
      expect(await notice.textContent()).not.toContain("Check any completed work");
      expect(await notice.textContent()).not.toContain("Automatic recovery has stopped");
      await page.reload();
      await notice.locator(".chat-run-failure__toggle").click();
      await details.waitFor();
      expect(await details.textContent()).toBe(summary);
    });
  });

  it("keeps archived child failures out of the composer while paging past tool activity", async () => {
    await suite.withPage(diagnosticContext, async ({ page }) => {
      const childKey = "agent:main:dashboard:archived-child";
      const row = {
        key: childKey,
        sessionId: "archived-child",
        kind: "direct",
        label: "Prototype grouped commands",
        parentSessionKey: sessionKey,
        archived: true,
        archivedAt: 2,
        updatedAt: 2,
        status: "failed",
        hasActiveRun: false,
        lastRunId: "failed-child-run",
        lastRunError: "Synthetic provider interrupted the reply.",
      };
      const activity = Array.from({ length: 3 }, (_, index) => [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: `read-${index}`,
              name: "read",
              arguments: { path: "example.txt" },
            },
          ],
          __openclaw: { id: `call-${index}`, seq: 2 + index * 2 },
        },
        {
          role: "toolResult",
          toolName: "read",
          toolCallId: `read-${index}`,
          content: "Synthetic file contents",
          __openclaw: { id: `result-${index}`, seq: 3 + index * 2 },
        },
      ]).flat();
      const gateway = await installMockGateway(page, {
        sessionKey: childKey,
        sessions: [row],
        deferredRequests: [{ method: "chat.history", match: { cursor: "older-child" } }],
        methodResponses: {
          "chat.startup": {
            sessionId: row.sessionId,
            sessionInfo: row,
            messages: activity,
            hasMore: true,
            olderCursor: "older-child",
          },
          "chat.history": {
            sessionId: row.sessionId,
            sessionInfo: row,
            hasMore: false,
            messages: [
              {
                role: "user",
                content: "Please prototype grouped commands.",
                __openclaw: { id: "first", seq: 1 },
              },
            ],
          },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, childKey));
      const archived = page.getByText(
        "This session is archived. Unarchive it to continue the conversation.",
        { exact: true },
      );
      await archived.waitFor();
      const activityRow = page.locator(".chat-tool-row, .chat-activity-group__summary").first();
      await activityRow.waitFor();
      await gateway.waitForRequest("chat.history");
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const directory = createControlUiE2eArtifactDir("archived-child");
        const frame = await takeControlUiScreenshotFrame(
          page,
          page.locator(".shell"),
          [archived, activityRow],
          { animations: "disabled" },
        );
        await writeFile(path.join(directory, "archived-child.png"), frame.png);
      }
      await expect.poll(() => page.locator(".chat-error").count()).toBe(0);
      await gateway.resolveDeferred("chat.history", undefined, {
        match: { cursor: "older-child" },
      });
      await page.getByText("Please prototype grouped commands.", { exact: true }).waitFor();
      expect(await page.locator(".chat-history-boundary").count()).toBe(0);
      expect(await gateway.getRequests("chat.history")).toMatchObject([
        { params: { cursor: "older-child" } },
      ]);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });

  it("keeps a rejected session-change message and full redacted recovery text without disclosure", async () => {
    await suite.withPage(diagnosticContext, async ({ page }) => {
      const prompt = "Continue reviewing the example project";
      const skillPath = "/home/operator/.openclaw/projects/example/.agents/skills/review";
      const diagnostic = `DispatchSessionRefreshRequiredError: Session "${sessionKey}" changed while starting work. Retry.\nroot="${skillPath}" | INVALID_BUNDLE.\npassword=synthetic-password`;
      const recovery =
        "Your message didn't run because the conversation changed. Refresh the conversation, then send it again.";
      const errorMessage = `${recovery}\n\n${diagnostic}`;
      const safeError = errorMessage.replace("password=synthetic-password", "password=[redacted]");
      const gateway = await installMockGateway(page, { sessionKey });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const { runId } = await sendPrompt(page, gateway, prompt);
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
      expect(await alert.locator(".app-toast__message").textContent()).toBe(safeError);
      expect(
        await alert
          .locator("details, [aria-expanded], .lazy-view-error__detail, .report-issue-link")
          .count(),
      ).toBe(0);
      expect(await alert.textContent()).not.toContain("synthetic-password");
      expect(await page.locator(".chat-thread").textContent()).toContain(prompt);
      await expectMobileFit(page, alert);
      const input = page.locator(".agent-chat__input textarea");
      await input.fill("A newer draft stays here");
      const historyCount = (await gateway.getRequests("chat.history")).length;
      await exactButton(alert, "Refresh").click();
      await gateway.waitForRequest("chat.history", { after: historyCount });
      expect(await input.inputValue()).toBe("A newer draft stays here");
      expect(await page.locator(".chat-thread").textContent()).toContain(prompt);
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
    });
  });
});
