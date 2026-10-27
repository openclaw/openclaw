import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI queued startup wait" });

suite.define(() => {
  it.each(["first accepted message", "restored queued run"])(
    "waits for startup progress: %s",
    async (scenario) => {
      await suite.withPage({ viewport: { height: 800, width: 1200 } }, async ({ page }) => {
        const first = scenario === "first accepted message";
        const sessionKey = first ? "agent:main:cold-custody" : "agent:main:main";
        const runId = "queued-recovery-run";
        const message = first ? "Inspect the first message ordering." : "Continue after restart.";
        const sessionInfo = {
          key: sessionKey,
          hasActiveRun: true,
          status: first ? "running" : "queued",
        };
        const sessionId = "cold-custody-session";
        const pending = {
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
        };
        const gateway = await installMockGateway(page, {
          sessionKey,
          sessionInfo: { ...sessionInfo, ...(!first ? { activeRunIds: [runId] } : {}) },
          ...(first
            ? {
                sessions: [{ ...sessionInfo, sessionId, kind: "direct" }],
                methodResponses: {
                  "chat.startup": {
                    sessionId,
                    sessionInfo,
                    messages: [],
                    pendingInputs: { total: 1, items: [pending] },
                  },
                },
              }
            : {
                agentModel: "openai/gpt-4.1",
                models: [{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }],
                historyMessages: [{ role: "user", content: message, timestamp: 1 }],
                inFlightRun: { runId, text: "" },
              }),
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const prompt = page.locator(".chat-group.user").filter({ hasText: message });
        const status = page.locator(".chat-working-indicator");
        const stop = page.getByRole("button", { name: "Stop generating" });
        if (first) {
          await prompt.waitFor();
          await status.waitFor();
          const promptBox = await prompt.boundingBox();
          const statusBox = await status.boundingBox();
          expect(statusBox!.y).toBeGreaterThanOrEqual(promptBox!.y + promptBox!.height);
        } else {
          const statusText = status.locator(".chat-working-indicator__status > span:first-child");
          await stop.waitFor();
          await statusText.waitFor();
          await page.getByText(message, { exact: true }).waitFor();
          expect(await statusText.textContent()).toBe("Waiting for turn to start");
          await gateway.emitGatewayEvent("chat", {
            sessionKey,
            runId,
            state: "status",
            phase: "preparing_context",
            seq: 1,
          });
          await expect.poll(() => statusText.textContent()).toBe("Preparing this turn…");
          await stop.click();
          expect((await gateway.waitForRequest("chat.abort")).params).toMatchObject({
            sessionKey,
            runId,
          });
        }
      });
    },
  );
});
