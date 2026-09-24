import { vi } from "vitest";
import type { ChannelManager } from "./server-channels.js";

export function createMockChannelManager(overrides?: Partial<ChannelManager>): ChannelManager {
  return {
    getRuntimeSnapshot: vi.fn(() => ({ channels: {}, channelAccounts: {} })),
    pauseChannelStarts: vi.fn(() => () => {}),
    startChannels: vi.fn(async () => {}),
    startChannel: vi.fn(async () => new Map()),
    stopChannel: vi.fn(async () => {}),
    releaseChannelRouteHandoffs: vi.fn(),
    setAutostartSuppression: vi.fn(),
    getAutostartSuppression: vi.fn(() => null),
    recoverAutostartSuppression: vi.fn(async () => false),
    setAmbientAutostartSuppressedChannelIds: vi.fn(),
    isAmbientAutostartSuppressed: vi.fn(() => false),
    markChannelLoggedOut: vi.fn(),
    isHealthMonitorEnabled: vi.fn(() => true),
    isAccountListed: vi.fn(() => true),
    isManuallyStopped: vi.fn(() => false),
    isAutoRestartScheduled: vi.fn(() => false),
    resetRestartAttempts: vi.fn(),
    ...overrides,
  };
}
