// Agent-command turns (subagent announces, inter-session steps) get the delivering account's
// formatting contract once when their visible output reaches a channel.
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
vi.mock("../config/io.js", () => ({
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
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        source: "test",
        plugin: {
          ...createOutboundTestPlugin({
            id: "telegram",
            outbound: createDirectOutboundTestAdapter({ channel: "telegram" }),
          }),
          agentPrompt: {
            inboundFormattingHints: (params: {
              cfg: OpenClawConfig;
              accountId?: string | null;
            }) => ({
              text_markup: params.cfg.channels?.telegram?.accounts?.[params.accountId ?? ""]
                ?.richMessages
                ? "markdown_telegram_rich"
                : "markdown",
              rules: [],
            }),
          },
        },
      },
    ]),
  );
});

it.each([
  { turn: "a delivered announce", mode: { deliver: true }, accountId: "rich", rich: true },
  {
    turn: "a delivery through another account",
    mode: { deliver: true, replyAccountId: "plain" },
    accountId: "rich",
    rich: false,
  },
  {
    turn: "a message-tool announce",
    mode: { sourceReplyDeliveryMode: "message_tool_only" as const },
    accountId: "plain",
    rich: false,
  },
  { turn: "an undelivered turn", mode: {}, accountId: "rich", rich: undefined },
])(
  "gives $turn from the $accountId account its delivering formatting contract",
  async (testCase) => {
    await withTempHome(async (home) => {
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
      } as OpenClawConfig);

      await agentCommandFromIngress(
        {
          message: "child finished",
          agentId: "main",
          sessionKey: "agent:main:telegram:direct:1222",
          to: "+1222",
          channel: "telegram",
          accountId: testCase.accountId,
          extraSystemPrompt: "Announce the child result.",
          allowModelOverride: false,
          sessionEffects: "internal",
          ...testCase.mode,
        },
        createThrowingTestRuntime(),
      );

      const prompt = vi.mocked(runEmbeddedAgent).mock.calls.at(-1)?.[0].extraSystemPrompt ?? "";
      if (testCase.rich === undefined) {
        expect(prompt).toBe("Announce the child result.");
        return;
      }
      const markup = testCase.rich ? "markdown_telegram_rich" : "markdown";
      expect(prompt.startsWith("Announce the child result.\n\n### Delivery Format")).toBe(true);
      expect(prompt.split("### Delivery Format")).toHaveLength(2);
      expect(prompt).toContain(`"text_markup": "${markup}"`);
    });
  },
);
