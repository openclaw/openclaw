// Control UI E2E proof for native delegated work inside a live Talk session.
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  captureComposerProof,
  installTalkBrowserFixtures,
  TALK_READY_HISTORY_MESSAGE,
  waitForTalkReady,
} from "./browser-talk-start-stop.fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI browser Talk working status",
  browserLaunchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
});

suite.define(() => {
  it("keeps listening visible while delegated work is active", async () => {
    await suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
      const relaySessionId = "relay-e2e-working-status";
      const gateway = await installMockGateway(page, {
        historyMessages: [TALK_READY_HISTORY_MESSAGE],
        methodResponses: {
          "talk.client.create": {
            provider: "openai",
            transport: "gateway-relay",
            relaySessionId,
            audio: {
              inputEncoding: "pcm16",
              inputSampleRateHz: 16_000,
              outputEncoding: "pcm16",
              outputSampleRateHz: 24_000,
            },
          },
          "talk.session.appendAudio": {},
          "talk.session.close": {},
        },
      });
      await installTalkBrowserFixtures(page);

      await page.goto(`${suite.server.baseUrl}chat`);
      await page.setViewportSize({ width: 1366, height: 900 });
      await waitForTalkReady(page);
      await page.getByRole("button", { name: "Start voice input" }).click();
      await gateway.waitForRequest("talk.client.create");
      await gateway.emitGatewayEvent("talk.event", { relaySessionId, type: "ready" });
      await expect
        .poll(() => page.locator('.agent-chat__voice-activity[data-status="listening"]').count())
        .toBe(1);

      const talkEvent = {
        sessionId: relaySessionId,
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
        provider: "openai",
        turnId: "turn-working",
        callId: "native-consult-working",
        timestamp: "2026-10-03T12:00:00.000Z",
      };
      await gateway.emitGatewayEvent("talk.event", {
        relaySessionId,
        type: "talkEvent",
        talkEvent: {
          ...talkEvent,
          id: "event-working",
          seq: 1,
          type: "tool.call",
          payload: { name: "openclaw_agent_consult", status: "working" },
        },
      });

      const working = page.locator('.agent-chat__voice-work-status[role="status"]');
      await expect.poll(() => working.textContent()).toContain("Working...");
      await expect
        .poll(() => page.locator('.agent-chat__voice-activity[data-status="listening"]').count())
        .toBe(1);
      await captureComposerProof(suite, page, "voice-working-status.png");

      await gateway.emitGatewayEvent("talk.event", {
        relaySessionId,
        type: "talkEvent",
        talkEvent: {
          ...talkEvent,
          id: "event-completed",
          seq: 2,
          type: "tool.result",
          payload: { name: "openclaw_agent_consult", status: "completed" },
          final: true,
        },
      });
      await expect.poll(() => working.count()).toBe(0);
    });
  });
});
