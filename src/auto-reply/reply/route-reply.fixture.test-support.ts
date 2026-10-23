import { afterEach, beforeEach, vi } from "vitest";
import type { ChannelOutboundAdapter, ChannelPlugin } from "../../channels/plugins/types.public.js";
import { installDeliveryQueueTmpDirHooks } from "../../infra/outbound/delivery-queue.test-helpers.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";

export function installRouteReplyFixture(restoreMocks = false) {
  const fixtures = installDeliveryQueueTmpDirHooks();
  beforeEach(() => vi.stubEnv("OPENCLAW_STATE_DIR", fixtures.tmpDir()));
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    if (restoreMocks) {
      vi.restoreAllMocks();
    }
    vi.unstubAllEnvs();
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });
  return {
    ...fixtures,
    register(
      outbound: ChannelOutboundAdapter,
      adapters: Pick<ChannelPlugin, "messaging" | "threading"> = {},
    ) {
      const plugin = { ...createOutboundTestPlugin({ id: "matrix", outbound }), ...adapters };
      setActivePluginRegistry(createTestRegistry([{ pluginId: "matrix", source: "test", plugin }]));
    },
  };
}
