import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("removes the typed /steer queue chip after consumption while the original run stays active", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const runId = "active-run";
    const sessionKey = "agent:main:main";
    const sessionInfo = { key: sessionKey, activeRunIds: [runId], hasActiveRun: true };
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          role: "user",
          content: "Check how the metrics file is populated.",
          __openclaw: { id: "original-user", idempotencyKey: runId + ":user", seq: 1 },
        },
      ],
      inFlightRun: { runId, text: "Checking the metrics pipeline." },
      sessionInfo,
    });
    try {
      await page.goto(suite.server.baseUrl + "chat");
      const stop = page.getByRole("button", { name: "Stop generating" });
      await stop.waitFor();
      const steerText = "Keep the numbers in metrics.json, not USER.md.";
      await gateway.deferNext("chat.send");
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("/steer " + steerText);
      await composer.press("Control+Enter");
      const sent = await gateway.waitForRequest("chat.send");
      const params = requireRecord(sent.params);
      expect(params).toMatchObject({ sessionKey, message: steerText, queueMode: "steer" });
      const steerRunId = requireString(params.idempotencyKey, "steer input identity");
      await gateway.resolveDeferred("chat.send", { runId: steerRunId, status: "started" });
      await gateway.emitGatewayEvent("session.message", {
        ...sessionInfo,
        sessionKey,
        clientRunId: steerRunId,
        message: {
          role: "user",
          content: [{ type: "text", text: steerText }],
          __openclaw: {
            id: "consumed-steer",
            idempotencyKey: steerRunId + ":user",
            seq: 2,
            steerTargetRunId: runId,
          },
        },
        messageId: "consumed-steer",
        messageSeq: 2,
      });
      const reply = "Understood. I will verify metrics.json and leave USER.md unchanged.";
      await gateway.emitGatewayEvent("chat", {
        runId,
        sessionKey,
        state: "delta",
        message: { role: "assistant", content: [{ type: "text", text: reply }] },
      });
      await expect
        .poll(() => page.locator(".chat-group.user", { hasText: steerText }).count())
        .toBe(1);
      await page.locator(".chat-thread-inner").getByText(reply, { exact: true }).waitFor();
      await stop.waitFor();
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const dir = createControlUiE2eArtifactDir("consumed-slash-steer", suite.artifactDir);
        await page
          .locator(".chat")
          .screenshot({ path: path.join(dir, "consumed-steer.png"), animations: "disabled" });
      }
      await expect.poll(() => page.locator(".chat-queue__item").count()).toBe(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
