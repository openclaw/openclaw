// Real-browser proof of frozen goal timing on the chat composer.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { createSessionGoalFixture } from "../../../src/gateway/session-goal.test-support.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { chatMessage } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI goal elapsed time" });
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let artifactDir: string;
beforeEach(() => {
  if (captureProof) {
    artifactDir = createControlUiE2eArtifactDir("goal-elapsed");
  }
});

suite.define(() => {
  it("shows a paused goal's frozen duration before and after opening details and reloading", async () => {
    await suite.withPage(
      {
        colorScheme: "light",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1440, height: 900 },
        ...(captureProof
          ? { recordVideo: { dir: artifactDir, size: { width: 1440, height: 900 } } }
          : {}),
      },
      async ({ page }) => {
        const stoppedAt = 1_098_940_000;
        await installMockGateway(page, {
          sessionKey: "agent:main:main",
          historyMessages: [chatMessage("assistant", "Deployment checks are ready.")],
          methodResponses: {
            "sessions.list": {
              ts: stoppedAt,
              path: "",
              count: 1,
              defaults: { model: "gpt-5.6-luna", modelProvider: "openai", contextTokens: 128_000 },
              sessions: [
                {
                  key: "agent:main:main",
                  kind: "direct",
                  displayName: "Deployment checks",
                  updatedAt: stoppedAt,
                  goal: createSessionGoalFixture("goal-timing", "Verify the deployment", {
                    status: "paused",
                    createdAt: 1_000,
                    updatedAt: stoppedAt,
                    pausedAt: stoppedAt,
                    tokensUsed: 100,
                  }),
                },
              ],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}chat/main`);
        const goal = page.locator(".agent-chat__goal");
        await goal.getByText("Goal paused", { exact: true }).waitFor();
        if (captureProof) {
          const frame = await takeControlUiScreenshotFrame(
            page,
            goal,
            [
              goal.getByText("Goal paused", { exact: true }),
              goal.locator(".agent-chat__goal-objective"),
            ],
            { animations: "disabled" },
          );
          await writeFile(path.join(artifactDir, "paused-goal.png"), frame.png);
        }
        expect(await goal.locator(".agent-chat__goal-elapsed").textContent()).toBe(
          "1wk 5d 17h 15m",
        );
        await goal.getByRole("button", { name: "Show goal details" }).click();
        expect(await goal.locator(".agent-chat__goal-detail-meta").textContent()).toContain(
          "1wk 5d 17h 15m",
        );
        await goal.getByRole("button", { name: "Hide goal details" }).click();
        expect(await goal.locator(".agent-chat__goal-elapsed").textContent()).toBe(
          "1wk 5d 17h 15m",
        );
        await page.reload();
        await goal.getByText("Goal paused", { exact: true }).waitFor();
        expect(await goal.locator(".agent-chat__goal-elapsed").textContent()).toBe(
          "1wk 5d 17h 15m",
        );
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('.chat-activity-pills [data-family="goal"]').click();
        const mobileGoal = page.locator('.chat-mobile-details-page[data-details-page="goal"]');
        const elapsed = mobileGoal.getByText("1wk 5d 17h 15m", { exact: true });
        const resume = mobileGoal.getByRole("button", { name: "Resume goal", exact: true });
        await elapsed.waitFor();
        await resume.waitFor();
        expect(await resume.isEnabled()).toBe(true);
        const elapsedBox = await elapsed.boundingBox();
        const resumeBox = await resume.boundingBox();
        if (!elapsedBox || !resumeBox) {
          throw new Error("Mobile Goal duration and Resume must have visible bounds");
        }
        expect(elapsedBox.x).toBeGreaterThanOrEqual(0);
        expect(elapsedBox.x + elapsedBox.width).toBeLessThanOrEqual(390);
        expect(resumeBox.x + resumeBox.width).toBeLessThanOrEqual(390);
        expect(
          elapsedBox.y + elapsedBox.height <= resumeBox.y ||
            resumeBox.y + resumeBox.height <= elapsedBox.y ||
            elapsedBox.x + elapsedBox.width <= resumeBox.x ||
            resumeBox.x + resumeBox.width <= elapsedBox.x,
        ).toBe(true);
        if (captureProof) {
          const frame = await takeControlUiScreenshotFrame(page, mobileGoal, [elapsed, resume], {
            animations: "disabled",
          });
          await writeFile(path.join(artifactDir, "paused-goal-mobile.png"), frame.png);
        }
      },
    );
  });
});
