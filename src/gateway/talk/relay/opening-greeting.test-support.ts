import { expect, it, onTestFinished, vi } from "vitest";
import type { RealtimeVoiceBridgeCreateRequest } from "../../../talk/provider-types.js";
import {
  makeRelayTransport,
  type createTrackedTalkRealtimeRelaySession,
} from "./index.test-support.js";
import {
  sendTalkRealtimeRelayAudio,
  stopTalkRealtimeRelaySession as stopTalkRealtimeRelaySessionRaw,
} from "./operations.js";
import { relaySessions } from "./state.js";

/** Reuses the persistent relay suite to prove Answer readiness and initial output ownership. */
export function defineRelayOpeningGreetingTests(
  createTalkRealtimeRelaySession: (
    params: Parameters<typeof createTrackedTalkRealtimeRelaySession>[1],
  ) => ReturnType<typeof createTrackedTalkRealtimeRelaySession>,
) {
  it.each([
    { interruptedForMs: 10_000, readinessDelayMs: 0, seconds: undefined },
    { interruptedForMs: 10_001, readinessDelayMs: 0, seconds: 10 },
    { interruptedForMs: 8_000, readinessDelayMs: 4_000, seconds: 12 },
  ])(
    "reports recovery once at accepted readiness: %j",
    async ({ interruptedForMs, readinessDelayMs, seconds }) => {
      const clock = vi.spyOn(performance, "now").mockReturnValue(500);
      onTestFinished(() => clock.mockRestore());
      let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
      const speak = vi.fn();
      const authority = vi.fn();
      const session = createTalkRealtimeRelaySession({
        context: { broadcastToConnIds: vi.fn() } as never,
        connId: "conn-recovery",
        provider: {
          id: "relay-test",
          label: "Relay Test",
          isConfigured: () => true,
          createBridge: (request) => {
            bridgeRequest = request;
            return makeRelayTransport({ triggerGreeting: speak });
          },
        },
        recovery: { interruptedForMs, receivedAt: 500 },
        assertGreetingAllowed: authority,
      });
      await sendTalkRealtimeRelayAudio({
        relaySessionId: session.relaySessionId,
        connId: "conn-recovery",
        audioBase64: Buffer.alloc(960).toString("base64"),
      });
      expect(speak).not.toHaveBeenCalled();
      clock.mockReturnValue(500 + readinessDelayMs);
      bridgeRequest?.onReady?.();
      if (seconds === undefined) {
        expect(speak).not.toHaveBeenCalled();
      } else {
        expect(speak).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining(`about ${seconds} seconds`),
        );
        expect(speak.mock.calls[0]?.[0]).toContain("Connection event, not a user utterance");
        expect(authority).toHaveBeenCalledOnce();
      }
      // Repeated readiness or later frames must not convert a short gap into a long one.
      clock.mockReturnValue(30_000);
      bridgeRequest?.onReady?.();
      await sendTalkRealtimeRelayAudio({
        relaySessionId: session.relaySessionId,
        connId: "conn-recovery",
        audioBase64: Buffer.alloc(960).toString("base64"),
      });
      expect(speak).toHaveBeenCalledTimes(seconds === undefined ? 0 : 1);
    },
  );

  it.each([
    ["greeting", "provider-first"],
    ["greeting", "client-first"],
    ["text", "provider-first"],
    ["text", "client-first"],
  ] as const)(
    "opens an accepted call once through %s support with %s readiness",
    async (method, readiness) => {
      let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
      const speak = vi.fn();
      const authority = vi.fn();
      const bridge = makeRelayTransport(
        method === "greeting" ? { triggerGreeting: speak } : { sendUserMessage: speak },
      );
      const session = createTalkRealtimeRelaySession({
        context: { broadcastToConnIds: vi.fn() } as never,
        connId: "conn-accepted-call",
        provider: {
          id: "relay-test",
          label: "Relay Test",
          isConfigured: () => true,
          createBridge: (request) => {
            bridgeRequest = request;
            return bridge;
          },
        },
        providerConfig: {},
        instructions: "Configured policy.",
        tools: [],
        greeting: "Briefly explain the prepared topic.",
        assertGreetingAllowed: authority,
      });
      expect(speak).not.toHaveBeenCalled();
      if (readiness === "provider-first") {
        bridgeRequest?.onReady?.();
      }
      expect(speak).not.toHaveBeenCalled();
      await sendTalkRealtimeRelayAudio({
        relaySessionId: session.relaySessionId,
        connId: "conn-accepted-call",
        audioBase64: Buffer.alloc(960).toString("base64"),
      });
      if (readiness === "client-first") {
        expect(speak).not.toHaveBeenCalled();
      }
      bridgeRequest?.onReady?.();
      bridgeRequest?.onReady?.();
      expect(authority).toHaveBeenCalledOnce();
      expect(speak).toHaveBeenCalledExactlyOnceWith("Briefly explain the prepared topic.");
    },
  );

  it.each([
    { reason: "closed", recovery: false },
    { reason: "revoked", recovery: false },
    { reason: "omitted", recovery: false },
    { reason: "closed", recovery: true },
    { reason: "revoked", recovery: true },
  ] as const)(
    "does not speak an opening after $reason (recovery: $recovery)",
    async ({ reason, recovery }) => {
      let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
      const speak = vi.fn();
      const bridge = makeRelayTransport({ triggerGreeting: speak });
      const session = createTalkRealtimeRelaySession({
        context: { broadcastToConnIds: vi.fn(), logGateway: { warn: vi.fn() } } as never,
        connId: "conn-greeting-guard",
        provider: {
          id: "relay-test",
          label: "Relay Test",
          isConfigured: () => true,
          createBridge: (request) => {
            bridgeRequest = request;
            return bridge;
          },
        },
        providerConfig: {},
        instructions: "Configured policy.",
        tools: [],
        ...(recovery
          ? { recovery: { interruptedForMs: 12_000, receivedAt: performance.now() } }
          : reason !== "omitted"
            ? { greeting: "Briefly explain the prepared topic." }
            : {}),
        assertGreetingAllowed: () => {
          if (reason === "revoked") {
            throw new Error("Ownership changed");
          }
        },
      });
      if (reason === "closed") {
        await stopTalkRealtimeRelaySessionRaw({
          relaySessionId: session.relaySessionId,
          connId: "conn-greeting-guard",
        });
      } else {
        await sendTalkRealtimeRelayAudio({
          relaySessionId: session.relaySessionId,
          connId: "conn-greeting-guard",
          audioBase64: Buffer.alloc(960).toString("base64"),
        });
      }
      bridgeRequest?.onReady?.();
      expect(speak).not.toHaveBeenCalled();
      if (reason === "revoked") {
        expect(relaySessions.has(session.relaySessionId)).toBe(false);
      }
    },
  );

  it.each(["continuous", "response"] as const)(
    "handles %s provider audio before client microphone input according to its output contract",
    (outputAudioMode) => {
      let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
      const broadcastToConnIds = vi.fn();
      const bridge = makeRelayTransport({ outputAudioMode });
      const session = createTalkRealtimeRelaySession({
        context: { broadcastToConnIds, logGateway: { warn: vi.fn() } } as never,
        connId: "conn-stream",
        provider: {
          id: "relay-test",
          label: "Relay Test",
          isConfigured: () => true,
          createBridge: (request) => {
            bridgeRequest = request;
            return bridge;
          },
        },
        providerConfig: {},
        instructions: "brief",
        tools: [],
      });
      bridgeRequest?.onReady?.();
      bridgeRequest?.onAudio(Buffer.alloc(960));
      const payloads = broadcastToConnIds.mock.calls.map(
        (call) => call[1] as Record<string, unknown>,
      );
      if (outputAudioMode === "continuous") {
        expect(payloads.some((payload) => payload.type === "audio")).toBe(true);
        expect(payloads.some((payload) => payload.type === "error")).toBe(false);
        expect(relaySessions.has(session.relaySessionId)).toBe(true);
      } else {
        expect(payloads.some((payload) => payload.type === "audio")).toBe(false);
        expect(payloads.some((payload) => payload.type === "error")).toBe(true);
        expect(relaySessions.has(session.relaySessionId)).toBe(false);
      }
    },
  );
}
