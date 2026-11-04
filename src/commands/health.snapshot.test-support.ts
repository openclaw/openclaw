import { vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { createSessionStoreSummaryReaderStub } from "../config/sessions/session-store-summary.test-support.js";

export type HealthTestPlugin = Pick<
  ChannelPlugin,
  "id" | "meta" | "capabilities" | "config" | "status"
>;

export async function loadFreshHealthModulesForTest(params: {
  getConfig: () => Record<string, unknown>;
  getSessionStorePath: () => string;
  getPlugins: () => HealthTestPlugin[];
}) {
  vi.doMock("../config/config.js", () => ({
    getRuntimeConfig: params.getConfig,
    loadConfig: params.getConfig,
  }));
  vi.doMock("../config/sessions/paths.js", () => ({
    resolveSessionStorePathCore: params.getSessionStorePath,
  }));
  vi.doMock("../config/sessions/session-entry-read-runtime.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../config/sessions/session-entry-read-runtime.js")>()),
    withSessionStoreReaderInWorker: createSessionStoreSummaryReaderStub(),
  }));
  vi.doMock("../channels/plugins/read-only.js", () => ({
    listReadOnlyChannelPluginsForConfig: params.getPlugins,
  }));

  const [pluginsRuntime, pluginDegradedState, channelTestUtils, health] = await Promise.all([
    import("../plugins/runtime.js"),
    import("../plugins/runtime-degraded-state.js"),
    import("../test-utils/channel-plugins.js"),
    import("../gateway/health/collector.js"),
  ]);
  return {
    setActivePluginRegistry: pluginsRuntime.setActivePluginRegistry,
    setActiveDegradedPlugins: pluginDegradedState.setActiveDegradedPlugins,
    createChannelTestPluginBase: channelTestUtils.createChannelTestPluginBase,
    createTestRegistry: channelTestUtils.createTestRegistry,
    collectGatewayHealthSnapshot: health.collectGatewayHealthSnapshot,
  };
}
