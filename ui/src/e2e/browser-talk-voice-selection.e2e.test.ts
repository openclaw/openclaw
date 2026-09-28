import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  dispatchOpenAiTalkEvent,
  installOpenAiTalkFixture,
  TALK_READY_HISTORY_MESSAGE,
  videoTalkCatalog,
  waitForTalkReady,
} from "./browser-talk-start-stop.fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Talk voice selection",
  browserLaunchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
});

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
      const selection = {
        voiceSessionId: "voice-original",
        sessionKey: "agent:main:main",
        provider: "openai",
        model: "gpt-live-1",
        voice: "marin",
        voices: ["marin", "alloy"],
        canChange: true,
      };
      const gateway = await installMockGateway(page, {
        heldMethods: ["chat.startup"],
        historyMessages: [TALK_READY_HISTORY_MESSAGE],
        methodResponses: {
          "talk.catalog": videoTalkCatalog("openai"),
          "talk.client.create": clientSession,
        },
      });
      await installOpenAiTalkFixture(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await gateway.resolveDeferred("chat.startup");
      await waitForTalkReady(page);
      await page.getByRole("button", { name: "Start voice input" }).click();
      const openAudio = async () => {
        await page.waitForFunction(() => {
          const current = (
            window as Window & {
              openclawVideoTalkE2e?: {
                dataChannelCreated: boolean;
                peer: { connectionState: string };
              };
            }
          ).openclawVideoTalkE2e;
          return current?.dataChannelCreated && current.peer.connectionState !== "closed";
        });
        await page.evaluate(() => {
          (
            window as Window & {
              openclawVideoTalkE2e?: { peer: { channel: EventTarget } };
            }
          ).openclawVideoTalkE2e?.peer.channel.dispatchEvent(new Event("open"));
        });
      };
      await gateway.waitForRequest("talk.client.create");
      await openAudio();
      await page.getByRole("button", { name: "Stop voice input" }).waitFor();
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
      await transcript("Keep working while I change your voice.");
      const captions = page.getByRole("log", { name: "Voice transcript" });
      await expect
        .poll(() => captions.textContent())
        .toContain("Keep working while I change your voice.");

      await gateway.deferNext("chat.send");
      const textarea = page.locator(".agent-chat__input textarea");
      await textarea.fill("Prepare the report");
      await textarea.press("Enter");
      const send = await gateway.waitForRequest("chat.send");
      const runId =
        typeof send.params === "object" && send.params !== null && "idempotencyKey" in send.params
          ? String(send.params.idempotencyKey)
          : "";
      expect(runId).not.toBe("");
      await gateway.resolveDeferred("chat.send", {
        runId,
        status: "started",
      });
      const stopRun = page.getByRole("button", { name: "Stop generating" });
      await expect.poll(() => stopRun.isVisible()).toBe(true);
      await page.screenshot({
        animations: "disabled",
        path: path.join(suite.artifactDir, "01-active-call.png"),
      });

      // The agent can still request a voice handoff through the Gateway event.
      await gateway.deferNext("talk.client.create");
      await gateway.emitGatewayEvent("talk.voice.change", {
        sessionKey: selection.sessionKey,
        voiceSessionId: selection.voiceSessionId,
        changeId: "voice-change",
        voice: "alloy",
        phase: "requested",
      });
      const replacement = await gateway.waitForRequest("talk.client.create", { after: 1 });
      expect(replacement.params).toMatchObject({
        sessionKey: selection.sessionKey,
        transport: "webrtc",
        voice: "alloy",
        voiceChangeId: "voice-change",
      });
      expect(await gateway.getRequests("talk.voice.complete")).toHaveLength(0);
      expect(await stopRun.isVisible()).toBe(true);
      expect(await captions.textContent()).toContain("Keep working while I change your voice.");

      const applied = { ...selection, voiceSessionId: "voice-replacement", voice: "alloy" };
      await gateway.resolveDeferred("talk.client.create", {
        ...clientSession,
        voiceSessionId: applied.voiceSessionId,
      });
      await openAudio();
      expect((await gateway.waitForRequest("talk.voice.complete")).params).toEqual({
        changeId: "voice-change",
        voiceSessionId: applied.voiceSessionId,
        outcome: "ready",
      });
      await transcript("The new voice is ready.");
      await expect.poll(() => captions.textContent()).toContain("The new voice is ready.");
      expect(await captions.textContent()).toContain("Keep working while I change your voice.");
      expect(await stopRun.isVisible()).toBe(true);
      await page.screenshot({
        animations: "disabled",
        path: path.join(suite.artifactDir, "03-after-voice-change.png"),
      });
      await page.getByRole("button", { name: "Stop voice input" }).click();
      await expect
        .poll(() => page.getByRole("button", { name: "Stop voice input" }).count())
        .toBe(0);
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
          "config.get": {
            exists: true,
            valid: true,
            config,
            raw: JSON.stringify(config),
            hash: "voice-settings",
          },
          "config.schema": {
            schema: {
              type: "object",
              properties: { talk: { type: "object", additionalProperties: true } },
            },
            uiHints: {},
            version: "test",
          },
          "talk.catalog": {
            realtime: {
              activeProvider: "openai",
              ready: true,
              providers: [
                {
                  id: "openai",
                  label: "OpenAI",
                  configured: true,
                  models: ["gpt-realtime"],
                  voices: ["alloy", "marin"],
                  transports: ["webrtc"],
                },
              ],
            },
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/talk`);
      const voice = page.getByRole("combobox", { name: "Speaker voice", exact: true });
      await expect.poll(() => voice.inputValue()).toBe("marin");
      await voice.selectOption("alloy");
      const save = await gateway.waitForRequest("config.set");
      expect(save.params).toMatchObject({ raw: expect.any(String) });
      const raw = (save.params as { raw: string }).raw;
      expect(JSON.parse(raw)).toMatchObject({
        talk: { realtime: { speakerVoice: "alloy" } },
      });
      await expect
        .poll(() => page.locator("openclaw-settings-save-indicator").textContent())
        .toContain("Saved");
      await page.reload();
      await expect.poll(() => voice.inputValue()).toBe("alloy");
      await page.screenshot({
        animations: "disabled",
        path: path.join(suite.artifactDir, "04-talk-settings.png"),
      });
    });
  });
});
