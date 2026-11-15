import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { expectCount, textMessage } from "./chat-flow-fixtures.test-support.ts";
import { exactButton, requireRecord } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { captureFrame } from "./sidebar-assertions.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI completed goal resume" });
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

suite.define(() => {
  it("resumes an achieved goal only on explicit operator input", async () => {
    const artifacts = captureProof
      ? createControlUiE2eArtifactDir("goal-complete-resume")
      : undefined;
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, colorScheme: "light" },
      async ({ page }) => {
        const now = Date.now();
        const goal = {
          schemaVersion: 1,
          id: "goal-checklist",
          objective: "Verify the sample deployment checklist",
          status: "complete",
          createdAt: now - 60_000,
          updatedAt: now,
          completedAt: now,
          tokenStart: 0,
          tokensUsed: 100,
          continuationTurns: 2,
        };
        const method = "sessions.goal.update";
        const row = createControlUiSessionRow("agent:main:main", "Deployment checklist", now, {
          sessionId: "goal-checklist-session",
          goal,
          status: "queued",
          hasActiveRun: true,
          activeRunIds: ["waiting-human-input"],
        });
        const gateway = await installMockGateway(page, {
          sessionKey: "agent:main:main",
          heldMethods: [method],
          historyMessages: [textMessage("assistant", "The deployment checklist is verified.")],
          sessions: [row],
          sessionInfo: row,
          inFlightRun: { runId: "waiting-human-input", text: "" },
        });
        await page.goto(`${suite.server.baseUrl}chat/main`);
        const card = page.locator(".agent-chat__goal");
        await card.getByText("Goal achieved", { exact: true }).waitFor();
        await page.getByText("The deployment checklist is verified.", { exact: true }).waitFor();
        const resume = exactButton(card, "Resume goal");
        await expectCount(exactButton(card, "Clear goal"), 1);
        expect(await gateway.getRequests(method)).toHaveLength(0);
        const capture = async (name: string) => {
          if (artifacts) {
            await captureFrame(artifacts, name, card, [
              card.locator(".agent-chat__goal-label"),
              card.locator(".agent-chat__goal-objective"),
            ]);
          }
        };
        await capture("waiting-input-goal.png");
        expect(await resume.isDisabled()).toBe(true);
        expect(await resume.evaluate((button) => getComputedStyle(button).opacity)).toBe("0.5");
        expect(await exactButton(card, "Clear goal").isEnabled()).toBe(true);
        const idle = {
          ...row,
          status: "done",
          hasActiveRun: false,
          activeRunIds: [],
          lastRunId: "waiting-human-input",
          updatedAt: now + 1,
        };
        await gateway.setSessionsListResponse({ sessions: [idle] });
        await gateway.setMethodResponse("chat.history", {
          sessionId: row.sessionId,
          sessionInfo: idle,
          messages: [textMessage("assistant", "The deployment checklist is verified.")],
        });
        await gateway.emitGatewayEvent("chat", {
          sessionKey: row.key,
          runId: "waiting-human-input",
          state: "final",
          message: textMessage("assistant", "The queued check has settled."),
        });
        await gateway.emitGatewayEvent("sessions.changed", { ...idle, reason: "lifecycle" });
        await expect.poll(() => resume.isEnabled()).toBe(true);
        await capture("achieved-goal.png");
        await resume.click();
        const params = requireRecord((await gateway.waitForRequest(method)).params);
        expect(params).toMatchObject({
          sessionKey: "agent:main:main",
          sessionId: "goal-checklist-session",
          goalId: goal.id,
          action: "resume",
          operationId: expect.any(String),
        });
        await card.getByText("Resuming goal…", { exact: true }).waitFor();
        const { completedAt: _completedAt, ...retained } = goal;
        const resumed = { ...retained, status: "active", updatedAt: now + 1_000 };
        await gateway.setSessionsListResponse({
          sessions: [{ ...(await gateway.getSessionRow("agent:main:main")), goal: resumed }],
        });
        await gateway.resolveDeferred(method, {
          operationId: params.operationId,
          action: "resume",
          status: "started",
          sessionId: "goal-checklist-session",
          goalId: goal.id,
          goal: resumed,
          runId: "goal-continuation",
        });
        await card.getByText("Pursuing goal", { exact: true }).waitFor();
        expect(await gateway.getRequests(method)).toHaveLength(1);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(await card.locator(".agent-chat__goal-objective").textContent()).toBe(
          goal.objective,
        );
        await capture("resumed-goal.png");
      },
    );
  });
});
