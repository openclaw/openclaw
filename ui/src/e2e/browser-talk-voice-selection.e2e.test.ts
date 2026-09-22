import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  dispatchOpenAiTalkEvent,
  installOpenAiTalkFixture,
  videoTalkCatalog,
} from "./browser-talk-start-stop.fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Talk voice selection",
  browserLaunchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
});

suite.define(() => {
  it("replaces the call through the voice picker while preserving captions and agent work", async () => {
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
        methodResponses: {
          "talk.catalog": videoTalkCatalog("openai"),
          "talk.client.create": clientSession,
          "talk.voice.get": selection,
        },
      });
      await installOpenAiTalkFixture(page);
      await page.goto(`${suite.server.baseUrl}chat`);
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
      const picker = page.locator(".chat-talk-voice-picker");
      await expect.poll(() => picker.textContent()).toContain("marin");
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
      await page.screenshot({ path: path.join(suite.artifactDir, "01-before-voice-change.png") });

      await gateway.deferNext("talk.voice.set");
      await picker.getByRole("button").click();
      await picker.getByRole("option", { name: "alloy" }).waitFor();
      await page.screenshot({ path: path.join(suite.artifactDir, "02-voice-choices.png") });
      await picker.locator('[data-value="alloy"]').click();
      expect((await gateway.waitForRequest("talk.voice.set")).params).toEqual({
        sessionKey: selection.sessionKey,
        voiceSessionId: selection.voiceSessionId,
        voice: "alloy",
      });
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
      expect(await picker.getByRole("button").isDisabled()).toBe(true);
      expect(await stopRun.isVisible()).toBe(true);
      expect(await captions.textContent()).toContain("Keep working while I change your voice.");

      const applied = { ...selection, voiceSessionId: "voice-replacement", voice: "alloy" };
      await gateway.setMethodResponse("talk.voice.get", applied);
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
      await gateway.resolveDeferred("talk.voice.set", { ...applied, status: "applied" });
      await expect.poll(() => picker.getByRole("button").isEnabled()).toBe(true);
      expect(await picker.textContent()).toContain("alloy");
      await transcript("The new voice is ready.");
      await expect.poll(() => captions.textContent()).toContain("The new voice is ready.");
      expect(await captions.textContent()).toContain("Keep working while I change your voice.");
      expect(await stopRun.isVisible()).toBe(true);
      await page.screenshot({ path: path.join(suite.artifactDir, "03-after-voice-change.png") });
      await page.getByRole("button", { name: "Stop voice input" }).click();
      await expect.poll(() => picker.count()).toBe(0);
      expect(await stopRun.isVisible()).toBe(true);
      expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
    });
  });
});
