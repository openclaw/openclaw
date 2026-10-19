import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI queued startup wait" });

suite.define(() => {
  it("keeps the first accepted message above startup progress before run identity arrives", async () => {
    await suite.withPage({ viewport: { height: 800, width: 1200 } }, async ({ page }) => {
      const sessionKey = "agent:main:cold-custody";
      const message = "Inspect the first message ordering.";
      await installMockGateway(page, {
        sessionKey,
        sessions: [
          {
            key: sessionKey,
            sessionId: "cold-custody-session",
            kind: "direct",
            hasActiveRun: true,
            status: "running",
          },
        ],
        sessionInfo: { key: sessionKey, hasActiveRun: true, status: "running" },
        methodResponses: {
          "chat.startup": {
            sessionId: "cold-custody-session",
            sessionInfo: { key: sessionKey, hasActiveRun: true, status: "running" },
            messages: [],
            pendingInputs: {
              total: 1,
              items: [
                {
                  id: "first-input",
                  runId: "first-run",
                  state: "queued",
                  acceptedAt: 1,
                  message: {
                    role: "user",
                    content: message,
                    timestamp: 1,
                    __openclaw: { id: "pending:first-input" },
                  },
                },
              ],
            },
          },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const prompt = page.locator(".chat-group.user").filter({ hasText: message });
      const status = page.locator(".chat-working-indicator");
      await prompt.waitFor();
      await status.waitFor();
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const frame = await takeControlUiScreenshotFrame(
          page,
          page.locator("openclaw-app"),
          [prompt, status],
          { animations: "disabled" },
        );
        await writeFile(path.join(suite.artifactDir, "first-message-order.png"), frame.png);
      }
      const promptBox = await prompt.boundingBox();
      const statusBox = await status.boundingBox();
      expect(statusBox!.y).toBeGreaterThanOrEqual(promptBox!.y + promptBox!.height);
    });
  });
  it("waits for authoritative startup progress after restoring a queued run", async () => {
    await suite.withPage(
      { viewport: { height: 800, width: 1200 } },
      async ({ page: currentPage }) => {
        const sessionKey = "agent:main:main";
        const runId = "queued-recovery-run";
        const gateway = await installMockGateway(currentPage, {
          sessionKey,
          agentModel: "openai/gpt-4.1",
          models: [{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }],
          historyMessages: [{ role: "user", content: "Continue after restart.", timestamp: 1 }],
          inFlightRun: { runId, text: "" },
          sessionInfo: {
            key: sessionKey,
            hasActiveRun: true,
            activeRunIds: [runId],
            status: "queued",
          },
        });
        await currentPage.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const status = currentPage.locator(".chat-working-indicator__status > span:first-child");
        const stop = currentPage.getByRole("button", { name: "Stop generating" });
        await stop.waitFor();
        await status.waitFor();
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const frame = await takeControlUiScreenshotFrame(
            currentPage,
            currentPage.locator("openclaw-app"),
            [status, stop, currentPage.getByText("Continue after restart.", { exact: true })],
            { animations: "disabled" },
          );
          await writeFile(path.join(suite.artifactDir, "queued-recovery.png"), frame.png);
        }
        expect(await status.textContent()).toBe("Waiting for turn to start…");
        await gateway.emitGatewayEvent("chat", {
          sessionKey,
          runId,
          state: "status",
          phase: "preparing_context",
          seq: 1,
        });
        await expect.poll(() => status.textContent()).toBe("Preparing this turn…");
        await stop.click();
        const abort = await gateway.waitForRequest("chat.abort");
        expect(abort.params).toMatchObject({ sessionKey, runId });
      },
    );
  });
});
