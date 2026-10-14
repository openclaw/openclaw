import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Terminal failure after active-run reload" });

suite.define(() => {
  it("loads the durable failure notice after reloading an active run", async () => {
    await suite.withPage({ viewport: { width: 1160, height: 850 } }, async ({ page }) => {
      const sessionKey = "agent:main:main";
      const runId = "reloaded-run";
      const now = Date.now();
      const prompt = {
        role: "user",
        content: "Summarize the project status.",
        timestamp: now - 2,
        __openclaw: { id: "input", seq: 1, runId, idempotencyKey: runId + ":user" },
      };
      const active = {
        key: sessionKey,
        sessionId: "reloaded-session",
        kind: "direct",
        updatedAt: now,
        status: "running",
        hasActiveRun: true,
        activeRunIds: [runId],
      };
      const history = {
        sessionId: active.sessionId,
        sessionInfo: active,
        messages: [prompt],
        inFlightRun: { runId, text: "", events: [] },
      };
      const gateway = await installMockGateway(page, {
        sessionKey,
        methodResponses: {
          "sessions.list": { sessions: [active], count: 1, path: "", ts: now },
          "chat.startup": history,
          "chat.history": history,
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await page.getByRole("button", { name: "Stop generating" }).waitFor();
      await page.reload();
      await page.getByRole("button", { name: "Stop generating" }).waitFor();
      const draft = page.locator(".agent-chat__input textarea");
      await draft.fill("Keep this unsent draft");
      const summary = "The AI service is temporarily unavailable.";
      const notice = {
        role: "custom",
        customType: "run-failed-before-reply",
        content: summary,
        timestamp: now + 1,
        details: { runId, error: summary },
        openclawRunError: { runId, summary },
        __openclaw: { id: "failure", seq: 2, runId },
      };
      const failed = {
        ...active,
        status: "failed",
        hasActiveRun: false,
        activeRunIds: [],
        lastRunId: runId,
        lastRunError: summary,
        endedAt: now + 1,
        updatedAt: now + 1,
      };
      const settled = {
        sessionId: active.sessionId,
        sessionInfo: failed,
        messages: [prompt, notice],
      };
      await gateway.setMethodResponse("chat.history", settled);
      await gateway.setMethodResponse("chat.startup", settled);
      await gateway.setSessionsListResponse({
        sessions: [failed],
        count: 1,
        path: "",
        ts: now + 1,
      });
      // The Gateway persists a custom receipt, then emits chat.error and its session snapshot.
      // Custom reports do not emit session.message.
      await gateway.emitGatewayEvent("chat", {
        sessionKey,
        runId,
        state: "error",
        errorMessage: summary,
      });
      await gateway.emitGatewayEvent("sessions.changed", {
        sessionKey,
        runId,
        phase: "error",
        ts: now + 1,
        session: failed,
        ...failed,
      });
      await expect
        .poll(() => page.getByRole("button", { name: "Stop generating" }).count())
        .toBe(0);
      await page.locator(".chat-run-failure").waitFor();
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const thread = page.locator(".chat-thread");
        const frame = await takeControlUiScreenshotFrame(page, thread, [draft], {
          animations: "disabled",
          elements: [thread],
        });
        await fs.writeFile(path.join(suite.artifactDir, "terminal.png"), frame.png);
      }
      expect(await page.locator(".chat-run-failure").count()).toBe(1);
      await page.getByRole("button", { name: "Try again", exact: true }).waitFor();
      expect(await page.locator(".chat-error").count()).toBe(0);
      expect(await draft.inputValue()).toBe("Keep this unsent draft");
    });
  });
});
