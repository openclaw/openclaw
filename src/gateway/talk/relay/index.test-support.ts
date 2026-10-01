// Shared relay test doubles for the talk realtime gateway relay suites.
import { vi } from "vitest";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import type { RealtimeVoiceBridge } from "../../../talk/provider-types.js";
import { stopTalkRealtimeRelaySession } from "./operations.js";
import { drainingRelaySessions } from "./state.js";

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
