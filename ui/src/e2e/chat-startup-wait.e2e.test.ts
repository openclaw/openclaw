import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI queued startup wait" });

suite.define(() => {
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
