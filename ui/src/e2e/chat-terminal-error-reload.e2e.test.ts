import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Terminal failure after active-run reload" });
const sessionKey = "agent:main:main";
const answer = "The fix is published and verified.";
function message(
  role: string,
  content: string,
  timestamp: number,
  metadata: Record<string, unknown>,
) {
  return { role, content, timestamp, __openclaw: metadata };
}

suite.define(() => {
  it.each([
    { name: "visible internal-result notice", suppressed: false, reloadActive: false },
    { name: "suppressed internal-result notice", suppressed: true, reloadActive: false },
    { name: "durable failure after active-run reload", suppressed: undefined, reloadActive: true },
  ])("preserves $name", async ({ suppressed, reloadActive }) => {
    await suite.withPage({ viewport: { width: 1160, height: 850 } }, async ({ page }) => {
      const runId = reloadActive ? "reloaded-run" : "followup-run";
      const now = Date.now();
      const messages = reloadActive
        ? [
            message("user", "Summarize the project status.", now - 2, {
              id: "input",
              seq: 1,
              runId,
              idempotencyKey: runId + ":user",
            }),
          ]
        : [
            message("user", "Publish the verified fix.", now - 3, {
              id: "request",
              seq: 1,
              runId: "user-run",
            }),
            message("assistant", answer, now - 2, { id: "answer", seq: 2, runId: "user-run" }),
          ];
      const active = {
        key: sessionKey,
        sessionId: reloadActive ? "reloaded-session" : "notice-policy-session",
        kind: "direct",
        updatedAt: now,
        status: "running",
        hasActiveRun: true,
        activeRunIds: [runId],
      };
      const history = {
        sessionId: active.sessionId,
        sessionInfo: active,
        messages,
        inFlightRun: { runId, text: "", events: [] },
      };
      const gateway = await installMockGateway(page, {
        sessionKey,
        sessions: [active],
        methodResponses: {
          "chat.history": history,
          ...(reloadActive ? { "chat.startup": history } : {}),
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const stop = page.getByRole("button", { name: "Stop generating" });
      const failure = page.locator(".chat-run-failure");
      const draft = page.locator(".agent-chat__input textarea");
      await stop.waitFor();
      if (reloadActive) {
        await page.reload();
        await stop.waitFor();
        await draft.fill("Keep this unsent draft");
      }
      const summary = reloadActive
        ? "The AI service is temporarily unavailable."
        : "No answer was returned. Ask again if you still need one.";
      const noticePolicy = suppressed === undefined ? {} : { suppressErrorNotice: suppressed };
      const failed = {
        ...active,
        status: "failed",
        hasActiveRun: false,
        activeRunIds: [],
        lastRunId: runId,
        lastRunError: summary,
        endedAt: now + 1,
        updatedAt: now + 1,
        ...noticePolicy,
      };
      const notice = {
        role: "custom",
        customType: "run-failed-before-reply",
        content: summary,
        ...(reloadActive
          ? { timestamp: now + 1 }
          : { display: !suppressed, excludeFromContext: true }),
        details: { runId, error: summary },
        ...(!suppressed ? { openclawRunError: { runId, summary } } : {}),
        __openclaw: { id: "failure", seq: reloadActive ? 2 : 3, runId },
      };
      // History is display-projected; custom receipts have no session.message event.
      const settled = {
        sessionId: active.sessionId,
        sessionInfo: failed,
        messages: suppressed ? messages : [...messages, notice],
      };
      await gateway.setMethodResponse("chat.history", settled);
      await gateway.setMethodResponse("chat.startup", settled);
      await gateway.setSessionsListResponse({
        sessions: [failed],
        count: 1,
        path: "",
        ts: now + 1,
      });
      await gateway.emitGatewayEvent("chat", {
        sessionKey,
        runId,
        state: "error",
        errorMessage: summary,
        ...noticePolicy,
      });
      await gateway.emitGatewayEvent("sessions.changed", {
        sessionKey,
        runId,
        phase: "error",
        ts: now + 1,
        session: failed,
        ...failed,
      });
      await expect.poll(() => stop.count()).toBe(0);
      const expectNotice = async () => {
        await expect.poll(() => failure.count()).toBe(suppressed ? 0 : 1);
        if (suppressed) {
          expect(await page.getByText(summary, { exact: false }).count()).toBe(0);
        }
      };
      await expectNotice();
      if (reloadActive) {
        await failure.waitFor();
        expect(await failure.count()).toBe(1);
        await page.getByRole("button", { name: "Try again", exact: true }).waitFor();
        expect({
          errors: await page.locator(".chat-error").count(),
          draft: await draft.inputValue(),
        }).toEqual({ errors: 0, draft: "Keep this unsent draft" });
      } else {
        await page.reload();
        await page.getByText(answer, { exact: true }).waitFor();
        await expectNotice();
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      }
    });
  });
});
