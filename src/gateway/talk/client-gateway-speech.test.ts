import { describe, expect, it, vi } from "vitest";
import { buildRealtimeVoiceSpeakExactMessage } from "../../talk/exact-speech-protocol.js";
import { activate, createControlFixture } from "./client-control-fixture.test-support.js";
import { sendTalkClientGatewayControlSpeech } from "./client-gateway-control.js";
import { sessionTarget } from "./client-gateway-control.test-support.js";
import { cleanupTalkConnection } from "./session-registry.js";

const envelope = (text: string) =>
  buildRealtimeVoiceSpeakExactMessage({ text, surfaceLabel: "the caller" });

describe("Gateway-controlled client speech", () => {
  it("requires a ready call owned by the exact connection and session", async () => {
    const fixture = createControlFixture({ voiceSessionId: "speech-owner", connId: "speech-conn" });
    const request = {
      voiceSessionId: fixture.voiceSessionId,
      connId: fixture.connId,
      sessionTarget,
      text: "The relay is on.",
    };
    fixture.owner.control.bindBridge(fixture.bridge);
    try {
      expect(() => sendTalkClientGatewayControlSpeech(request)).toThrow("not active");
      await activate(fixture.owner);
      expect(() => sendTalkClientGatewayControlSpeech(request)).toThrow("not ready");
      fixture.owner.control.onReady?.();
      expect(() =>
        sendTalkClientGatewayControlSpeech({ ...request, connId: "another-connection" }),
      ).toThrow("not owned");
      for (const field of ["sessionKey", "canonicalKey", "agentId", "storePath"] as const) {
        expect(() =>
          sendTalkClientGatewayControlSpeech({
            ...request,
            sessionTarget: { ...sessionTarget, [field]: "another-target" },
          }),
        ).toThrow("not owned");
      }
      expect(fixture.bridge.sendUserMessage).not.toHaveBeenCalled();
      sendTalkClientGatewayControlSpeech(request);
      expect(fixture.bridge.sendUserMessage).toHaveBeenCalledWith(envelope(request.text));
      cleanupTalkConnection(fixture.connId, { warn: vi.fn() });
      expect(() => sendTalkClientGatewayControlSpeech(request)).toThrow("closed");
      expect(fixture.bridge.sendUserMessage).toHaveBeenCalledOnce();
    } finally {
      await fixture.owner.close();
    }
  });

  it("rejects a ready call without a speech transport", async () => {
    const { owner, voiceSessionId, connId } = createControlFixture({
      voiceSessionId: "speech-no-transport",
      connId: "speech-no-transport-conn",
    });
    try {
      await activate(owner);
      owner.control.onReady?.();
      expect(() =>
        sendTalkClientGatewayControlSpeech({
          voiceSessionId,
          connId,
          sessionTarget,
          text: "Done.",
        }),
      ).toThrow("not ready");
    } finally {
      await owner.close();
    }
  });

  it("handles native playback echoes without consuming a real consultation's completion claim", async () => {
    const claimAppend = vi.fn(() => true);
    const runAgentConsult = Object.assign(
      vi.fn(async () => ({ text: "Task result." })),
      {
        claimAppend,
      },
    );
    const fixture = createControlFixture({
      voiceSessionId: "speech-native",
      connId: "speech-native-conn",
      controlSource: "delegation",
      runAgentConsult,
    });
    fixture.owner.control.bindControl({ sendUserMessage: fixture.bridge.sendUserMessage });
    await activate(fixture.owner);
    fixture.owner.control.onReady?.();
    fixture.owner.runAgentConsult.adoptCompletionClaims?.();
    const speak = (text: string) =>
      sendTalkClientGatewayControlSpeech({ ...fixture, sessionTarget, text });
    const reply = vi.fn();
    try {
      speak("on");
      expect(fixture.owner.control.handleDelegationInput?.(envelope("on"), reply)).toBe("control");
      expect(reply).toHaveBeenCalledWith("on");
      expect(claimAppend).not.toHaveBeenCalled();
      expect(runAgentConsult).not.toHaveBeenCalled();
      expect(fixture.owner.control.handleDelegationInput?.('Set the relay to "on"', reply)).toBe(
        "consult",
      );
      expect(fixture.owner.runAgentConsult.claimAppend?.()).toBe(true);
      expect(claimAppend).toHaveBeenCalledOnce();
      for (let index = 0; index < 8; index++) {
        speak(`Result ${index}`);
      }
      expect(fixture.owner.control.handleDelegationInput?.(envelope("on"), reply)).toBe("consult");
      fixture.bridge.sendUserMessage.mockImplementationOnce(() => {
        throw new Error("Transport failed");
      });
      expect(() => speak("Failed result")).toThrow("Transport failed");
      expect(fixture.owner.control.handleDelegationInput?.(envelope("Failed result"), reply)).toBe(
        "consult",
      );
      expect(fixture.owner.control.handleDelegationInput?.(envelope("Result 7"), reply)).toBe(
        "control",
      );
    } finally {
      await fixture.owner.close();
    }
  });

  it("acknowledges a synchronous tool echo without starting an agent", async () => {
    const fixture = createControlFixture({
      voiceSessionId: "speech-tool",
      connId: "speech-tool-conn",
    });
    fixture.owner.control.bindBridge(fixture.bridge);
    await activate(fixture.owner);
    fixture.owner.control.onReady?.();
    fixture.bridge.sendUserMessage.mockImplementation((message: string) => {
      fixture.owner.control.onToolCall?.({
        itemId: "speech-item",
        callId: "speech-call",
        name: "openclaw_agent_consult",
        args: { question: message },
      });
    });
    try {
      sendTalkClientGatewayControlSpeech({ ...fixture, sessionTarget, text: "Done." });
      expect(fixture.bridge.submitToolResult).toHaveBeenCalledWith("speech-call", {
        result: "Done.",
      });
      expect(fixture.runToolAgentConsult).not.toHaveBeenCalled();
      expect(fixture.runAgentConsult).not.toHaveBeenCalled();
    } finally {
      await fixture.owner.close();
    }
  });

  it("does not carry retained speech into a replacement call", async () => {
    const original = createControlFixture({
      voiceSessionId: "speech-replacement",
      connId: "speech-original-conn",
      controlSource: "delegation",
    });
    original.owner.control.bindBridge(original.bridge);
    await activate(original.owner);
    original.owner.control.onReady?.();
    sendTalkClientGatewayControlSpeech({ ...original, sessionTarget, text: "Old result." });
    const replacement = createControlFixture({
      voiceSessionId: original.voiceSessionId,
      connId: "speech-replacement-conn",
      controlSource: "delegation",
    });
    replacement.owner.control.bindBridge(replacement.bridge);
    try {
      await activate(replacement.owner);
      replacement.owner.control.onReady?.();
      expect(() =>
        sendTalkClientGatewayControlSpeech({ ...original, sessionTarget, text: "Late result." }),
      ).toThrow("not owned");
      expect(
        replacement.owner.control.handleDelegationInput?.(envelope("Old result."), vi.fn()),
      ).toBe("consult");
      expect(original.bridge.sendUserMessage).toHaveBeenCalledOnce();
      expect(replacement.bridge.sendUserMessage).not.toHaveBeenCalled();
    } finally {
      await Promise.all([original.owner.close(), replacement.owner.close()]);
    }
  });
});
