import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  dispatchOpenAiTalkEvent,
  installOpenAiTalkFixture,
  TALK_READY_HISTORY_MESSAGE,
  videoTalkCatalog,
  waitForTalkReady,
} from "./browser-talk-start-stop.fixtures.ts";
import { requireRecord, requireString } from "./chat-flow.test-support.ts";
import { configSchema, configSnapshot } from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Talk voice selection",
  browserLaunchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
});
type TalkWindow = Window & {
  openclawVideoTalkE2e?: {
    dataChannelCreated: boolean;
    peer: { connectionState: string; channel: EventTarget };
  };
};

suite.define(() => {
  it("keeps the composer free of voice settings while preserving agent-requested voice changes", async () => {
    await suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
      const clientSession = {
        provider: "openai",
        voiceSessionId: "voice-original",
        transport: "webrtc",
        clientSecret: "test-client-secret",
        offerUrl: "https://api.openai.com/v1/realtime/calls",
      };
      const gateway = await installMockGateway(page, {
        historyMessages: [TALK_READY_HISTORY_MESSAGE],
        methodResponses: {
          "talk.catalog": videoTalkCatalog("openai"),
          "talk.client.create": clientSession,
        },
      });
      await installOpenAiTalkFixture(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      await waitForTalkReady(page);
      await page.getByRole("button", { name: "Start voice input" }).click();
      const stopVoice = page.getByRole("button", { name: "Stop voice input" });
      const openAudio = () =>
        page.waitForFunction(() => {
          const current = (window as TalkWindow).openclawVideoTalkE2e;
          return (
            current?.dataChannelCreated &&
            current.peer.connectionState !== "closed" &&
            current.peer.channel.dispatchEvent(new Event("open"))
          );
        });
      await gateway.waitForRequest("talk.client.create");
      await openAudio();
      await stopVoice.waitFor();
      expect(await page.locator(".chat-talk-voice-picker").count()).toBe(0);
      const transcript = async (text: string) => {
        await dispatchOpenAiTalkEvent(page, {
          type: "conversation.item.added",
          previous_item_id: null,
          item: {
            id: "speech",
            type: "message",
            role: "user",
            content: [{ type: "input_audio", transcript: null }],
          },
        });
        await dispatchOpenAiTalkEvent(page, {
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "speech",
          transcript: text,
        });
      };
      const originalTranscript = "Keep working while I change your voice.";
      await transcript(originalTranscript);
      const captions = page.getByRole("log", { name: "Voice transcript" });
      await expect.poll(() => captions.textContent()).toContain(originalTranscript);

      await gateway.deferNext("chat.send");
      const textarea = page.locator(".agent-chat__input textarea");
      await textarea.fill("Prepare the report");
      await textarea.press("Enter");
      const sent = requireRecord((await gateway.waitForRequest("chat.send")).params);
      const runId = requireString(sent.idempotencyKey, "sent run ID");
      await gateway.resolveDeferred("chat.send", { runId, status: "started" });
      const stopRun = page.getByRole("button", { name: "Stop generating" });
      await expect.poll(() => stopRun.isVisible()).toBe(true);

      await gateway.deferNext("talk.client.create");
      await gateway.emitGatewayEvent("talk.voice.change", {
        sessionKey: "agent:main:main",
        voiceSessionId: clientSession.voiceSessionId,
        changeId: "voice-change",
        voice: "alloy",
        phase: "requested",
      });
      const replacement = await gateway.waitForRequest("talk.client.create", { after: 1 });
      expect(replacement.params).toMatchObject({
        sessionKey: "agent:main:main",
        transport: "webrtc",
        voice: "alloy",
        voiceChangeId: "voice-change",
      });
      expect(await gateway.getRequests("talk.voice.complete")).toHaveLength(0);
      expect(await stopRun.isVisible()).toBe(true);
      expect(await captions.textContent()).toContain(originalTranscript);

      await gateway.resolveDeferred("talk.client.create", {
        ...clientSession,
        voiceSessionId: "voice-replacement",
      });
      await openAudio();
      expect((await gateway.waitForRequest("talk.voice.complete")).params).toEqual({
        changeId: "voice-change",
        voiceSessionId: "voice-replacement",
        outcome: "ready",
      });
      await transcript("The new voice is ready.");
      await expect.poll(() => captions.textContent()).toContain("The new voice is ready.");
      expect(await captions.textContent()).toContain(originalTranscript);
      expect(await stopRun.isVisible()).toBe(true);
      await stopVoice.click();
      await expect.poll(() => stopVoice.count()).toBe(0);
      expect(await gateway.getRequests("talk.voice.get")).toHaveLength(0);
      expect(await gateway.getRequests("talk.voice.set")).toHaveLength(0);
      expect(await stopRun.isVisible()).toBe(true);
      expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
    });
  });

  it("keeps the speaker voice editable and saved in Talk settings", async () => {
    await suite.withPage({}, async ({ page }) => {
      const config = {
        talk: { realtime: { provider: "openai", model: "gpt-realtime", speakerVoice: "marin" } },
      };
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "config.get": { exists: true, ...configSnapshot(config, "voice-settings") },
          "config.schema": configSchema({
            type: "object",
            properties: { talk: { type: "object", additionalProperties: true } },
          }),
          "talk.catalog": {
            realtime: {
              providers: [{ id: "openai", label: "OpenAI", voices: ["alloy", "marin"] }],
            },
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/talk`);
      const voice = page.getByRole("combobox", { name: "Speaker voice", exact: true });
      await expect.poll(() => voice.inputValue()).toBe("marin");
      await voice.selectOption("alloy");
      const save = await gateway.waitForRequest("config.set");
      const raw = requireString(requireRecord(save.params).raw, "saved config");
      expect(JSON.parse(raw)).toMatchObject({
        talk: { realtime: { speakerVoice: "alloy" } },
      });
      await expect
        .poll(() => page.locator("openclaw-settings-save-indicator").textContent())
        .toContain("Saved");
      await page.reload();
      await expect.poll(() => voice.inputValue()).toBe("alloy");
    });
  });
});
