// Replies get the delivering Telegram account's formatting contract once.
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as embeddedAgent from "../../agents/embedded-agent.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetSystemEventsForTest } from "../../infra/system-events.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createReplyAgentDefaults } from "./get-reply-config.test-support.js";
import { withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import { getReplyFromConfig } from "./get-reply.js";
import { finalizeInboundContext } from "./inbound-context.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetSystemEventsForTest();
  resetPluginRuntimeStateForTest();
});

it("gives a Telegram reply on the rich account its contract once", () =>
  withOpenClawTestState(
    { label: "reply-delivery-format", env: { OPENCLAW_TEST_FAST: "0" } },
    async (state) => {
      resetSystemEventsForTest();
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "telegram",
            source: "test",
            plugin: {
              ...createChannelTestPluginBase({ id: "telegram" }),
              agentPrompt: {
                inboundFormattingHints: (params: {
                  cfg: OpenClawConfig;
                  accountId?: string | null;
                }) =>
                  params.cfg.channels?.telegram?.accounts?.[params.accountId ?? ""]?.richMessages
                    ? { text_markup: "markdown_telegram_rich", rules: ["Telegram rich ON."] }
                    : { text_markup: "markdown", rules: ["Telegram rich OFF."] },
              },
            },
          },
        ]),
      );
      const cfg = withFullRuntimeReplyConfig({
        agents: { defaults: createReplyAgentDefaults(state.workspaceDir) },
        channels: {
          telegram: {
            allowFrom: ["*"],
            accounts: { rich: { richMessages: true }, plain: { richMessages: false } },
          },
        },
        plugins: { enabled: false },
        session: { store: path.join(state.root, "sessions.json") },
      } as OpenClawConfig);
      await state.writeConfig(cfg);
      const { setRuntimeConfigSnapshot } = await import("../../config/runtime-snapshot.js");
      setRuntimeConfigSnapshot(cfg);
      const runAgent = vi
        .spyOn(embeddedAgent, "runEmbeddedAgent")
        .mockImplementation(async (p) => ({
          payloads: [{ text: "HEARTBEAT_OK" }],
          meta: {
            durationMs: 1,
            agentMeta: { sessionId: p.sessionId, provider: "mock-openai", model: "gpt-5.6-luna" },
          },
        }));
      await getReplyFromConfig(
        finalizeInboundContext({
          Body: "Post the status table",
          Provider: "telegram",
          Surface: "telegram",
          OriginatingChannel: "telegram",
          OriginatingTo: "telegram:123",
          AccountId: "rich",
          ChatType: "direct",
          SessionKey: "agent:main:telegram:rich:direct:123",
        }),
        undefined,
        cfg,
      );
      const prompt = runAgent.mock.calls.at(-1)?.[0].extraSystemPrompt ?? "";
      expect(prompt.split("### Delivery Format")).toHaveLength(2);
      expect(prompt).toContain('"text_markup": "markdown_telegram_rich"');
    },
  ));
