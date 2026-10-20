import { writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

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
        const gateway = await installMockGateway(page, {
          sessionKey: "agent:main:main",
          heldMethods: [method],
          historyMessages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "The deployment checklist is verified." }],
            },
          ],
          methodResponses: {
            "sessions.list": {
              ts: now,
              path: "",
              count: 1,
              defaults: { model: "test-model", modelProvider: "test", contextTokens: 128_000 },
              sessions: [
                {
                  key: "agent:main:main",
                  sessionId: "goal-checklist-session",
                  kind: "direct",
                  displayName: "Deployment checklist",
                  updatedAt: now,
                  goal,
                },
              ],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}chat/main`);
        const card = page.locator(".agent-chat__goal");
        await card.getByText("Goal achieved", { exact: true }).waitFor();
        await page.getByText("The deployment checklist is verified.", { exact: true }).waitFor();
        const resume = card.getByRole("button", { name: "Resume goal", exact: true });
        await expect
          .poll(() => card.getByRole("button", { name: "Clear goal", exact: true }).count())
          .toBe(1);
        expect(await gateway.getRequests(method)).toHaveLength(0);
        const capture = async (name: string) => {
          if (!artifacts) {
            return;
          }
          const frame = await takeControlUiScreenshotFrame(
            page,
            card,
            [card.locator(".agent-chat__goal-label"), card.locator(".agent-chat__goal-objective")],
            { animations: "disabled", elements: [card] },
          );
          await writeFile(path.join(artifacts, name), frame.png);
        };
        await capture("achieved-goal.png");
        expect(await resume.count()).toBe(1);
        await resume.click();
        const request = await gateway.waitForRequest(method);
        assert(isRecord(request.params), "Expected Goal resume request parameters");
        expect(request.params).toMatchObject({
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
          operationId: request.params.operationId,
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
