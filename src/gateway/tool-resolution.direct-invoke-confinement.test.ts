import { afterEach, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

const cfg: OpenClawConfig = {
  plugins: { enabled: false },
  channels: { telegram: { botToken: "123:test" } },
  tools: { message: { crossContext: { confineChatTypes: ["group"] } } },
};

afterEach(() => {
  setActivePluginRegistry(createTestRegistry([]));
  clearRuntimeConfigSnapshot();
});

// `/tools/invoke` binds a call to a conversation through its headers; the bound
// topic's kind must reach the message tool so confinement applies as in a turn.
it.each([
  { name: "a sibling topic from a header-bound group call", bound: true, topic: 99, denied: true },
  { name: "the bound topic itself", bound: true, topic: 42, denied: false },
  { name: "a topic from a call bound to no conversation", bound: false, topic: 99, denied: false },
])("judges a direct send to $name", async ({ bound, topic, denied }) => {
  const { telegramPlugin } = await loadBundledPluginFacade<{ telegramPlugin: ChannelPlugin }>({
    pluginId: "telegram",
    artifactBasename: "api.ts",
  });
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "telegram", plugin: telegramPlugin, source: "test" }]),
  );
  setRuntimeConfigSnapshot(cfg);
  const { tools } = await resolveGatewayScopedTools({
    cfg,
    sessionKey: "agent:main:main",
    surface: "http",
    senderIsOwner: true,
    ...(bound
      ? {
          messageProvider: "telegram",
          agentTo: "telegram:-1001234567890:topic:42",
          agentThreadId: "42",
        }
      : {}),
  });
  const message = tools.find((tool) => tool.name === "message");
  const send = message?.execute("direct-1", {
    action: "send",
    channel: "telegram",
    target: `telegram:-1001234567890:topic:${topic}`,
    message: "probe",
    dryRun: true,
  });
  if (denied) {
    await expect(send).rejects.toThrow("confineChatTypes keeps group turns");
  } else {
    expect(JSON.stringify(await send)).toContain('"dryRun":true');
  }
});
