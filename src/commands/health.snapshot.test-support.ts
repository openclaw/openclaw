import { vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { createSessionStoreSummaryReaderStub } from "../config/sessions/session-store-summary.test-support.js";
import type { collectGatewayHealthSnapshot } from "../gateway/health/collector.js";

export type LegacyHealthSnapshotParams = Partial<
  Omit<Parameters<typeof collectGatewayHealthSnapshot>[0], "audience">
> & {
  includeSensitive?: boolean;
};

export type HealthTestPlugin = Pick<
  ChannelPlugin,
  "id" | "meta" | "capabilities" | "config" | "status"
>;

export async function loadFreshHealthModulesForTest(params: {
  getConfig: () => Record<string, unknown>;
  getSessionStorePath: () => string;
  getSessions: () => Record<string, never>;
  getPlugins: () => HealthTestPlugin[];
}) {
  vi.doMock("../config/config.js", () => ({
    getRuntimeConfig: params.getConfig,
    loadConfig: params.getConfig,
  }));
  vi.doMock("../config/sessions.js", () => ({
    resolveSessionStorePathCore: params.getSessionStorePath,
    resolveSessionFilePathCore: vi.fn(params.getSessionStorePath),
    loadSessionStore: params.getSessions,
    saveSessionStore: vi.fn().mockResolvedValue(undefined),
    readSessionUpdatedAt: vi.fn(() => undefined),
    recordSessionMetaFromInbound: vi.fn().mockResolvedValue(undefined),
    updateLastRoute: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock("../config/sessions/paths.js", () => ({
    resolveSessionStorePathCore: params.getSessionStorePath,
  }));
  vi.doMock("../config/sessions/session-entry-read-runtime.js", () => ({
    // Both callers exercise channel health with empty session stores.
    withSessionStoreReaderInWorker: createSessionStoreSummaryReaderStub((_scope, options) => ({
      count: 0,
      recent: [],
      byAgent: new Map(options.agentIds.map((agentId) => [agentId, { count: 0, recent: [] }])),
    })),
  }));
  vi.doMock("../plugins/runtime/runtime-web-channel-plugin.js", () => ({
    webAuthExists: vi.fn(async () => true),
    getWebAuthAgeMs: vi.fn(() => 1234),
    readWebSelfId: vi.fn(() => ({ e164: null, jid: null })),
    logWebSelfId: vi.fn(),
    logoutWeb: vi.fn(),
  }));
  vi.doMock("../channels/plugins/read-only.js", () => ({
    listReadOnlyChannelPluginsForConfig: params.getPlugins,
  }));

  const [
    { setActivePluginRegistry },
    { setActiveDegradedPlugins },
    { createChannelTestPluginBase, createTestRegistry },
    { collectGatewayHealthSnapshot },
  ] = await Promise.all([
    import("../plugins/runtime.js"),
    import("../plugins/runtime-degraded-state.js"),
    import("../test-utils/channel-plugins.js"),
    import("../gateway/health/collector.js"),
  ]);
  return {
    setActivePluginRegistry,
    setActiveDegradedPlugins,
    createChannelTestPluginBase,
    createTestRegistry,
    getHealthSnapshot: ({ includeSensitive, probe, ...rest }: LegacyHealthSnapshotParams = {}) =>
      collectGatewayHealthSnapshot({
        ...rest,
        audience: includeSensitive === false ? "public" : "admin",
        probe: probe !== false,
      }),
  };
}
