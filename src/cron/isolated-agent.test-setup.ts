import { vi } from "vitest";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { runSubagentAnnounceFlow } from "../agents/subagent-announce.js";
import { signalOutbound } from "../channels/plugins/outbound/signal.js";
import { telegramOutbound } from "../channels/plugins/outbound/telegram.js";
import { callGateway } from "../gateway/call.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";

export function setupIsolatedAgentTurnMocks(params?: { fast?: boolean }): void {
  if (params?.fast) {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  }
  vi.mocked(runEmbeddedPiAgent).mockReset();
  vi.mocked(loadModelCatalog).mockResolvedValue([]);
  vi.mocked(runSubagentAnnounceFlow).mockReset().mockResolvedValue(true);
  vi.mocked(callGateway).mockReset().mockResolvedValue({ ok: true, deleted: true });
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        plugin: createOutboundTestPlugin({ id: "telegram", outbound: telegramOutbound }),
        source: "test",
      },
      {
        pluginId: "signal",
        plugin: createOutboundTestPlugin({ id: "signal", outbound: signalOutbound }),
        source: "test",
      },
    ]),
  );
}
