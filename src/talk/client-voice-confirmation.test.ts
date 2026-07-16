import { afterEach, describe, expect, it } from "vitest";
import {
  activateClientVoiceConfirmationSession,
  authorizeClientVoiceConfirmation,
  noteClientVoiceConfirmationTranscript,
  resetClientVoiceConfirmationStateForTest,
  resolveClientVoiceToolConfirmationPolicy,
} from "./client-voice-confirmation.js";

afterEach(() => resetClientVoiceConfirmationStateForTest());

function confirmationIdFrom(reason: string): string {
  const match = reason.match(/VOICE_CONFIRMATION_REQUIRED:([^\s]+)/);
  if (!match?.[1]) {
    throw new Error(`missing confirmation id in: ${reason}`);
  }
  return match[1];
}

describe("client voice confirmation policy", () => {
  it("allows reads and routine reversible local writes", () => {
    activateClientVoiceConfirmationSession({
      sessionKey: "agent:main:main",
      voiceSessionId: "voice-1",
    });

    expect(
      resolveClientVoiceToolConfirmationPolicy({
        sessionKey: "agent:main:main",
        toolName: "read",
        toolParams: { path: "/tmp/file" },
      }),
    ).toEqual({ allowed: true });
    expect(
      resolveClientVoiceToolConfirmationPolicy({
        sessionKey: "agent:main:main",
        toolName: "write",
        toolParams: { path: "/tmp/file", content: "safe" },
      }),
    ).toEqual({ allowed: true });
  });

  it("binds a subsequent spoken yes to one exact outbound action", () => {
    const sessionKey = "agent:main:main";
    const voiceSessionId = "voice-1";
    const toolParams = { action: "send", to: "telegram:123", message: "hello" };
    activateClientVoiceConfirmationSession({ sessionKey, voiceSessionId });

    const blocked = resolveClientVoiceToolConfirmationPolicy({
      sessionKey,
      toolName: "message",
      toolParams,
      now: 1_000,
    });
    expect(blocked.allowed).toBe(false);
    const confirmationId = confirmationIdFrom(blocked.allowed ? "" : blocked.reason);

    expect(() =>
      authorizeClientVoiceConfirmation({
        sessionKey,
        voiceSessionId,
        confirmationId,
        now: 1_100,
      }),
    ).toThrow("explicit spoken confirmation");

    noteClientVoiceConfirmationTranscript({
      sessionKey,
      voiceSessionId,
      role: "user",
      text: "Yes, do it.",
      timestamp: 1_050,
    });
    authorizeClientVoiceConfirmation({
      sessionKey,
      voiceSessionId,
      confirmationId,
      now: 1_100,
    });

    expect(
      resolveClientVoiceToolConfirmationPolicy({
        sessionKey,
        toolName: "message",
        toolParams,
        now: 1_200,
      }),
    ).toEqual({ allowed: true });
    expect(
      resolveClientVoiceToolConfirmationPolicy({
        sessionKey,
        toolName: "message",
        toolParams,
        now: 1_300,
      }).allowed,
    ).toBe(false);
  });

  it("does not authorize changed arguments or negative speech", () => {
    const sessionKey = "agent:main:main";
    const voiceSessionId = "voice-1";
    activateClientVoiceConfirmationSession({ sessionKey, voiceSessionId });
    const blocked = resolveClientVoiceToolConfirmationPolicy({
      sessionKey,
      toolName: "gateway",
      toolParams: { action: "config.patch", value: "first" },
      now: 2_000,
    });
    const confirmationId = confirmationIdFrom(blocked.allowed ? "" : blocked.reason);
    noteClientVoiceConfirmationTranscript({
      sessionKey,
      voiceSessionId,
      role: "user",
      text: "No, cancel that.",
      timestamp: 2_100,
    });
    expect(() =>
      authorizeClientVoiceConfirmation({
        sessionKey,
        voiceSessionId,
        confirmationId,
        now: 2_200,
      }),
    ).toThrow("explicit spoken confirmation");

    noteClientVoiceConfirmationTranscript({
      sessionKey,
      voiceSessionId,
      role: "user",
      text: "Confirm",
      timestamp: 2_300,
    });
    authorizeClientVoiceConfirmation({
      sessionKey,
      voiceSessionId,
      confirmationId,
      now: 2_400,
    });
    expect(
      resolveClientVoiceToolConfirmationPolicy({
        sessionKey,
        toolName: "gateway",
        toolParams: { action: "config.patch", value: "changed" },
        now: 2_500,
      }).allowed,
    ).toBe(false);
  });

  it("requires confirmation for destructive shell commands but not read-only ones", () => {
    const sessionKey = "agent:main:main";
    activateClientVoiceConfirmationSession({ sessionKey, voiceSessionId: "voice-1" });

    expect(
      resolveClientVoiceToolConfirmationPolicy({
        sessionKey,
        toolName: "exec",
        toolParams: { command: "cat /tmp/report" },
      }),
    ).toEqual({ allowed: true });
    expect(
      resolveClientVoiceToolConfirmationPolicy({
        sessionKey,
        toolName: "exec",
        toolParams: { command: "rm -rf /tmp/report" },
      }).allowed,
    ).toBe(false);
    expect(
      resolveClientVoiceToolConfirmationPolicy({
        sessionKey,
        toolName: "exec",
        toolParams: { command: "npm publish" },
      }).allowed,
    ).toBe(false);
    expect(
      resolveClientVoiceToolConfirmationPolicy({
        sessionKey,
        toolName: "exec",
        toolParams: { command: "curl https://example.test -d action=send" },
      }).allowed,
    ).toBe(false);
  });
});
