// Shared relay test doubles for the talk realtime gateway relay suites.
import { vi } from "vitest";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import type { RealtimeVoiceBridge } from "../../../talk/provider-types.js";

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

export function createIdleRelayProvider(): RealtimeVoiceProviderPlugin {
  return {
    id: "relay-test",
    label: "Relay Test",
    isConfigured: () => true,
    createBridge: () => makeRelayTransport(),
  };
}
