import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("shows local model waits after earlier output and clears them on response and cancellation", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, { historyMessages: [] });
    const artifactDir = createControlUiE2eArtifactDir("model-wait");
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("Compare these synthetic local model results.");
      await composer.press("Enter");
      const send = await gateway.waitForRequest("chat.send");
      const { idempotencyKey: runId, sessionKey } = send.params as {
        idempotencyKey: string;
        sessionKey: string;
      };
      const working = page.locator('.chat-working-indicator[role="status"]');
      const status = async (seq: number, phase: string, waitReason?: string) => {
        await gateway.emitGatewayEvent("chat", {
          runId,
          sessionKey,
          seq,
          state: "status",
          phase,
          waitReason,
        });
      };
      await status(1, "starting_model");
      await expect.poll(() => working.textContent()).toContain("Waiting for a response");
      await writeFile(
        path.join(artifactDir, "before-generic-wait.png"),
        await takeControlUiViewportScreenshot(page, page.locator(".shell"), [working]),
      );
      await status(2, "waiting_for_model", "slot");
      await expect.poll(() => working.textContent()).toContain("Waiting for a free model slot");
      await writeFile(
        path.join(artifactDir, "after-slot-wait.png"),
        await takeControlUiViewportScreenshot(page, page.locator(".shell"), [working]),
      );
      await gateway.emitGatewayEvent("chat", {
        runId,
        sessionKey,
        seq: 1,
        state: "delta",
        message: { role: "assistant", content: "First result." },
        deltaText: "First result.",
      });
      await gateway.emitGatewayEvent("agent", {
        runId,
        sessionKey,
        seq: 3,
        ts: 1,
        stream: "assistant",
        data: { text: "First result." },
      });
      await expect.poll(() => working.count()).toBe(0);
      await status(4, "waiting_for_model", "response");
      await expect
        .poll(() => working.textContent())
        .toContain("Waiting for the local model to respond");
      await status(3, "waiting_for_model", "slot");
      await expect
        .poll(() => working.textContent())
        .toContain("Waiting for the local model to respond");
      await writeFile(
        path.join(artifactDir, "response-wait.png"),
        await takeControlUiViewportScreenshot(page, page.locator(".shell"), [working]),
      );
      await gateway.emitGatewayEvent("chat", { runId, sessionKey, seq: 5, state: "aborted" });
      await expect.poll(() => working.count()).toBe(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
