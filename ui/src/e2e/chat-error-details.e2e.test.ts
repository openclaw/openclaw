import { writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page, Locator } from "playwright";
import { assert, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { exactButton, polledClipboard, polledVisible } from "./chat-presentation.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI chat error details" });
const sessionKey = "agent:main:main";

const diagnosticContext = {
  viewport: { height: 900, width: 1280 },
  permissions: ["clipboard-read", "clipboard-write"],
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

  it("keeps a rejected session-change message visible with recovery guidance and diagnostic details", async () => {
    await suite.withPage(diagnosticContext, async ({ page }) => {
      const prompt = "Continue reviewing the example project";
      const skillPath = "/home/operator/.openclaw/projects/example/.agents/skills/review";
      const diagnostic = `DispatchSessionRefreshRequiredError: Session "${sessionKey}" changed while starting work. Retry.\nroot="${skillPath}" | INVALID_BUNDLE.\npassword=synthetic-password`;
      const recovery =
        "Your message didn't run because the conversation changed. Refresh the conversation, then send it again.";
      const errorMessage = `${recovery}\n\n${diagnostic}`;
      const safeError = `Error: ${errorMessage.replace("password=synthetic-password", "password=[redacted]")}`;
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
      expect(await alert.locator("summary strong").textContent()).toBe(
        "Couldn't finish this reply. Check the conversation before trying again.",
      );
      expect(await alert.locator("summary").textContent()).not.toContain(skillPath);
      expect(await alert.locator("summary").textContent()).not.toContain("INVALID_BUNDLE");
      expect(await alert.getByLabel("Error details", { exact: true }).isVisible()).toBe(false);
      expect(await page.locator(".chat-thread").textContent()).toContain(prompt);
      await alert.locator("summary").click();
      const details = alert.getByLabel("Error details", { exact: true });
      await polledVisible(details).toBe(true);
      expect(await details.textContent()).toBe(safeError);
      await exactButton(alert, "Copy error").click();
      await polledClipboard(page).toBe(safeError);
      await expectMobileFit(page, alert);
      await alert.locator("summary").click();
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
