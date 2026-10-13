// Shared relay test doubles for the talk realtime gateway relay suites.
import { vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../../config/types.js";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import * as clientVoiceSession from "../../../talk/client-voice-session.js";
import type { RealtimeVoiceBridge } from "../../../talk/provider-types.js";
import { stopTalkRealtimeRelaySession } from "./operations.js";
import { drainingRelaySessions, relaySessions } from "./state.js";

export function createRelayAgentConfig(agentId: "main" | "ops"): OpenClawConfig {
  return {
    agents: { entries: { main: {}, ops: {} } },
    talk: { agentId },
  };
}

export function makeRelayTransport<
  Overrides extends Partial<RealtimeVoiceBridge> = Record<never, never>,
>(overrides: Overrides = {} as Overrides) {
  return {
    connect: vi.fn(async () => undefined),
    sendAudio: vi.fn(),
    setMediaTimestamp: vi.fn(),
    handleBargeIn: vi.fn(),
    submitToolResult: vi.fn(),
    acknowledgeMark: vi.fn(),
    close: vi.fn(),
    isConnected: vi.fn(() => true),
    ...overrides,
  };
}

export function createIdleRelayProvider(
  createBridge: RealtimeVoiceProviderPlugin["createBridge"] = () => makeRelayTransport(),
): RealtimeVoiceProviderPlugin {
  return {
    id: "relay-test",
    label: "Relay Test",
    isConfigured: () => true,
    createBridge,
  };
}

export async function drainRelayTestSessions(activeRelaySessions: Map<string, string>) {
  for (const [relaySessionId, connId] of activeRelaySessions) {
    try {
      await stopTalkRealtimeRelaySession({ relaySessionId, connId });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("Unknown realtime relay session")) {
        throw error;
      }
    }
  }
  await Promise.all(
    [...drainingRelaySessions].map(
      (session) => session.closing?.completion ?? session.voiceSessionClose ?? Promise.resolve(),
    ),
  );
  activeRelaySessions.clear();
}

export function ensureActiveRelayTurnId(relaySessionId: string): string {
  const relay = relaySessions.get(relaySessionId);
  if (!relay) {
    throw new Error(`Missing relay test session ${relaySessionId}`);
  }
  if (!relay.harness.talk.activeTurnId) {
    relay.harness.talk.startTurn({ turnId: "turn-1" });
  }
  return relay.harness.talk.activeTurnId ?? "turn-1";
}

export function observeRelayTranscriptFailures() {
  const failures = [createDeferred(), createDeferred()] as const;
  const append = clientVoiceSession.appendRelayVoiceTranscript;
  let attempt = 0;
  const observer = vi
    .spyOn(clientVoiceSession, "appendRelayVoiceTranscript")
    .mockImplementation((...args) => {
      const failure = failures[attempt++];
      const pending = append(...args);
      if (failure) {
        void pending.then(
          () => failure.reject(new Error("Expected relay transcript append failure")),
          () => failure.resolve(),
        );
      }
      return pending;
    });
  return {
    afterAttempt: (index: 0 | 1) => failures[index].promise,
    restore: () => observer.mockRestore(),
  };
}
