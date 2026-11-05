import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { beforeEach, expect, it, vi } from "vitest";
import "./agent-command.test-mocks.js";
import "./agent-command-attempt.test-mocks.js";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import {
  createDirectOutboundTestAdapter,
  createOutboundTestPlugin,
  createTestRegistry,
} from "../test-utils/channel-plugins.js";
import { createDefaultAgentResult } from "./agent-session.test-support.js";
import { agentCommandFromIngress } from "./agent.js";
import { createThrowingTestRuntime } from "./test-runtime-config-helpers.js";
const configIoMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  readConfigFileSnapshotForWrite: vi.fn(),
}));
// mock-isolation: Formatting cases supply account config in memory without loading persisted config.
vi.mock("../config/io.js", () => ({
  captureRuntimeConfigAsyncReader: () => async () => configIoMocks.loadConfig(),
  getRuntimeConfig: configIoMocks.loadConfig,
  loadConfig: configIoMocks.loadConfig,
  readConfigFileSnapshotForWrite: configIoMocks.readConfigFileSnapshotForWrite,
}));
vi.mock("../agents/command/delivery.runtime.js", () => ({
  deliverAgentCommandResult: vi.fn(async () => ({ payloads: [], meta: {} })),
}));
beforeEach(() => {
  vi.clearAllMocks();
  resetPluginRuntimeStateForTest();
  clearSessionStoreCacheForTest();
  vi.mocked(runEmbeddedAgent).mockResolvedValue(createDefaultAgentResult());
  configIoMocks.readConfigFileSnapshotForWrite.mockResolvedValue({
    snapshot: { valid: false, resolved: {} },
    writeOptions: {},
  });
  const plugin = createOutboundTestPlugin({
    id: "telegram",
    outbound: createDirectOutboundTestAdapter({ channel: "telegram" }),
  });
  plugin.agentPrompt = {
    inboundFormattingHints: ({ cfg, accountId }) => ({
      text_markup: cfg.channels?.telegram?.accounts?.[accountId ?? ""]?.richMessages
        ? "markdown_telegram_rich"
        : "markdown",
      rules: [],
    }),
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: "telegram", source: "test", plugin }]));
});

it.each([
  ["a delivered announce", { deliver: true }, "rich", true],
  ["a delivery through another account", { deliver: true, replyAccountId: "plain" }, "rich", false],
  ["a message-tool announce", { sourceReplyDeliveryMode: "message_tool_only" }, "plain", false],
] as const)("gives %s its delivering formatting contract", async (_turn, mode, accountId, rich) =>
  withTempHome(async (home) => {
    configIoMocks.loadConfig.mockReturnValue({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
          models: { "anthropic/claude-opus-4-6": {} },
          workspace: path.join(home, "openclaw"),
        },
      },
      session: { store: path.join(home, "sessions.json"), mainKey: "main" },
      channels: {
        telegram: { accounts: { rich: { richMessages: true }, plain: { richMessages: false } } },
      },
    } satisfies OpenClawConfig);
    await agentCommandFromIngress(
      {
        message: "child finished",
        agentId: "main",
        sessionKey: "agent:main:telegram:direct:1222",
        to: "+1222",
        channel: "telegram",
        accountId,
        extraSystemPrompt: "Announce the child result.",
        allowModelOverride: false,
        sessionEffects: "internal",
        ...mode,
      },
      createThrowingTestRuntime(),
    );
    const prompt = vi.mocked(runEmbeddedAgent).mock.calls.at(-1)?.[0].extraSystemPrompt ?? "";
    const markup = rich ? "markdown_telegram_rich" : "markdown";
    expect(prompt.startsWith("Announce the child result.\n\n### Delivery Format")).toBe(true);
    expect(prompt.split("### Delivery Format")).toHaveLength(2);
    expect(prompt).toContain(`"text_markup": "${markup}"`);
  }),
);
