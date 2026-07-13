/**
 * Focused regression tests for the relay audio base64 guard.
 * Validates that sendTalkRealtimeRelayAudio rejects malformed base64
 * while accepting valid unpadded frames (the key relay use case).
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  setActiveEmbeddedRun,
  testing as embeddedRunTesting,
} from "../agents/embedded-agent-runner/runs.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import {
  clearTalkRealtimeRelaySessionsForTest,
  createTalkRealtimeRelaySession,
  sendTalkRealtimeRelayAudio,
} from "./talk-realtime-relay.js";

describe("relay audio base64 guard", () => {
  afterEach(() => {
    clearTalkRealtimeRelaySessionsForTest();
    vi.useRealTimers();
    embeddedRunTesting.resetActiveEmbeddedRuns();
  });

  function createRelaySession() {
    const provider: RealtimeVoiceProviderPlugin = {
      id: "guard-test",
      label: "Guard Test",
      isConfigured: () => true,
      createBridge: () => ({
        connect: vi.fn(async () => undefined),
        sendAudio: vi.fn(),
        setMediaTimestamp: vi.fn(),
        handleBargeIn: vi.fn(),
        submitToolResult: vi.fn(),
        acknowledgeMark: vi.fn(),
        close: vi.fn(),
        isConnected: vi.fn(() => true),
      }),
    };
    return createTalkRealtimeRelaySession({
      context: {
        broadcastToConnIds: vi.fn(),
      } as never,
      connId: "conn-1",
      provider,
      providerConfig: { apiKey: "test" },
      instructions: "test",
      tools: [],
    });
  }

  it("accepts valid unpadded base64 audio frame", async () => {
    const session = createRelaySession();
    // Unpadded base64 — the key relay use case (browser APIs omit padding)
    expect(() =>
      sendTalkRealtimeRelayAudio({
        relaySessionId: session.relaySessionId,
        connId: "conn-1",
        audioBase64: "dGVzdA", // unpadded "test"
        timestamp: 123,
      }),
    ).not.toThrow();
  });

  it("accepts valid padded base64 audio frame", async () => {
    const session = createRelaySession();
    expect(() =>
      sendTalkRealtimeRelayAudio({
        relaySessionId: session.relaySessionId,
        connId: "conn-1",
        audioBase64: "dGVzdA==", // padded "test"
        timestamp: 123,
      }),
    ).not.toThrow();
  });

  it("rejects empty audio frame", async () => {
    const session = createRelaySession();
    expect(() =>
      sendTalkRealtimeRelayAudio({
        relaySessionId: session.relaySessionId,
        connId: "conn-1",
        audioBase64: "",
        timestamp: 123,
      }),
    ).toThrow("Realtime relay audio frame has invalid base64 encoding");
  });

  it("rejects malformed base64 audio frame", async () => {
    const session = createRelaySession();
    expect(() =>
      sendTalkRealtimeRelayAudio({
        relaySessionId: session.relaySessionId,
        connId: "conn-1",
        audioBase64: "not-base64!",
        timestamp: 123,
      }),
    ).toThrow("Realtime relay audio frame has invalid base64 encoding");
  });
});
