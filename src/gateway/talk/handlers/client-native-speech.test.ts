import { describe, expect, it } from "vitest";
import {
  connectNativeSession,
  installNativePluginTestHooks,
  nativeDelegation,
  upstream,
  withNativePlugin,
  withParkedNativeTask,
} from "./client-native-control.test-support.js";

describe("client speech through the public native Talk transport", () => {
  installNativePluginTestHooks();

  it("submits exact speech with operator.talk and rejects invalid UTF-8 byte lengths", async () => {
    await withNativePlugin(async (fixture) => {
      const { socket } = await connectNativeSession(fixture);
      const text = "The dial is ready.";
      expect(await fixture.invoke("talk.client.say", { text })).toEqual({ accepted: true });
      const message = socket.sent.find((frame) =>
        frame.includes("Internal OpenClaw voice playback result."),
      );
      expect(message).toBeDefined();
      expect(message).toContain("The dial is ready.");
      expect(upstream.runEmbeddedAgent).not.toHaveBeenCalled();
      expect(await fixture.invoke("talk.client.say", { text: "é".repeat(512) })).toEqual({
        accepted: true,
      });
      for (const params of [
        { text: " " },
        { text: "é".repeat(512) + "a" },
        { text: "a".repeat(1025) },
        { text, voiceSessionId: undefined },
        { text, unexpected: true },
      ]) {
        expect(await fixture.invokeResponse("talk.client.say", params)).toMatchObject([
          false,
          undefined,
          { code: "INVALID_REQUEST" },
        ]);
      }
    });
  });

  it("keeps an active native task's final response after a playback echo", async () => {
    await withParkedNativeTask(async ({ invoke, socket, activeRun, settleBackend }) => {
      expect(await invoke("talk.client.say", { text: "The dial is ready." })).toEqual({
        accepted: true,
      });
      const playback = [
        "Internal OpenClaw voice playback result.",
        "Do not call openclaw_agent_consult or any other tool for this message.",
        "Speak this exact OpenClaw answer to the caller, without adding, removing, or rephrasing words.",
        'Answer: "The dial is ready."',
      ].join("\n");
      socket.serverEvent(nativeDelegation("playback-echo", playback));
      await socket.waitForSent(
        (frame) =>
          frame.includes('"delegation_item_id":"playback-echo"') &&
          frame.includes("The dial is ready."),
      );
      expect(activeRun.abortSignal.aborted).toBe(false);
      expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
      await settleBackend();
      await socket.waitForSent(
        (frame) =>
          frame.includes('"delegation_item_id":"original-task"') &&
          frame.includes("Original task completed normally."),
      );
      expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
    });
  });
});
