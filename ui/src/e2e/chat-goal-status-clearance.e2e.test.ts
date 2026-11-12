import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createSessionGoalFixture } from "../../../src/gateway/session-goal.test-support.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  installMockGateway,
  controlUiBundledSettingsStorageKey,
  createControlUiMockBootstrapConfig,
  controlUiSessionUrl,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { chatMessage } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Goal and run status clearance" });

suite.define(() => {
  it("keeps a continued reply status clear of a long unmet goal at the transcript end", async () => {
    await suite.withPage(
      { viewport: { width: 1200, height: 800 }, colorScheme: "light" },
      async ({ page }) => {
        const now = Date.now();
        const row = createControlUiSessionRow(
          "agent:main:dashboard:goal-status",
          "Deployment verification",
          now,
          {
            sessionId: "goal-status-session",
            hasActiveRun: true,
            activeRunIds: ["continued-verification"],
            status: "running",
            goal: createSessionGoalFixture(
              "goal-status",
              "Continue the authorized Gateway memory regression repair in this existing session, verify the deployment and land the complete fix without losing unrelated work.",
              {
                status: "budget_limited",
                createdAt: now - 60_000,
                updatedAt: now,
                budgetLimitedAt: now,
              },
            ),
          },
        );
        await page.addInitScript(
          (key) => localStorage.setItem(key, JSON.stringify({ theme: "light" })),
          controlUiBundledSettingsStorageKey(suite.server.baseUrl),
        );
        await page.route("**/control-ui-config.json", (route) =>
          route.fulfill({
            json: { ...createControlUiMockBootstrapConfig(), chatBubblesEnabled: false },
          }),
        );
        const gateway = await installMockGateway(page, {
          sessionKey: row.key,
          sessions: [{ ...row, goal: undefined }],
          sessionInfo: { ...row, goal: undefined },
          inFlightRun: { runId: "continued-verification", text: "" },
          historyMessages: [
            ...Array.from({ length: 18 }, (_, index) =>
              chatMessage(
                "assistant",
                `Verification step ${index + 1}. The synthetic deployment checks preserve the existing workspace and record the test results.\n\nInspect the current state before continuing with the repair.`,
                { timestamp: now - 30_000 + index * 100 },
              ),
            ),
            {
              role: "custom",
              customType: "run-failed-before-reply",
              content: "Verification could not finish. Try again.",
              timestamp: now - 1,
              openclawRunError: {
                runId: "failed-verification",
                summary: "Verification could not finish. Try again.",
              },
              __openclaw: { id: "failure", seq: 20, runId: "failed-verification" },
            },
          ],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, row.key));
        const goal = page.locator(".agent-chat__goal");
        await page.locator(".chat-run-failure").waitFor();
        await gateway.emitGatewayEvent("chat", {
          sessionKey: row.key,
          runId: "continued-verification",
          state: "status",
          seq: 1,
          phase: "starting_model",
        });
        const working = page.locator(".chat-working-indicator");
        await working.waitFor();
        await gateway.setSessionsListResponse({ sessions: [row] });
        await gateway.emitGatewayEvent("sessions.changed", {
          ...row,
          updatedAt: now + 1,
          reason: "lifecycle",
        });
        await goal.getByText("Goal unmet", { exact: true }).waitFor();
        const artifacts = createControlUiE2eArtifactDir("goal-status-clearance");
        for (const expanded of [false, true]) {
          if (expanded) {
            await goal.getByRole("button", { name: "Show goal details" }).click();
          }
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator(".chat"),
            [working, goal],
            { animations: "disabled", elements: [page.locator(".chat-main__conversation-frame")] },
          );
          await writeFile(
            path.join(artifacts, expanded ? "expanded.png" : "collapsed.png"),
            frame.elements[0]!.png,
          );
          const geometry = await page.evaluate(() => {
            const bounds = (selector: string) => {
              const r = document.querySelector(selector)!.getBoundingClientRect();
              return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
            };
            return {
              working: bounds(".chat-working-indicator"),
              goal: bounds(".agent-chat__goal"),
              viewport: bounds(".chat-thread-viewport"),
              overlap: -Number.parseFloat(
                getComputedStyle(document.querySelector(".chat-footer")!).marginTop,
              ),
            };
          });
          console.log(JSON.stringify({ artifacts, geometry }));
          expect(
            geometry.goal.top - (geometry.viewport.bottom - geometry.overlap),
          ).toBeGreaterThanOrEqual(8);
          expect(geometry.working.bottom + 6).toBeLessThanOrEqual(geometry.goal.top);
        }
      },
    );
  });
});
