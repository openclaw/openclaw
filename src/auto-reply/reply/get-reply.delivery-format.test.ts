// Reply and event turns get the delivering Telegram account's formatting contract once.
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as embeddedAgent from "../../agents/embedded-agent.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetSystemEventsForTest } from "../../infra/system-events.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import { getReplyFromConfig } from "./get-reply.js";
import { finalizeInboundContext } from "./inbound-context.js";

let state: OpenClawTestState | undefined;
beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "telegram" }),
          agentPrompt: {
            inboundFormattingHints: (params: { cfg: OpenClawConfig; accountId?: string | null }) =>
              params.cfg.channels?.telegram?.accounts?.[params.accountId ?? ""]?.richMessages
                ? { text_markup: "markdown_telegram_rich", rules: ["Telegram rich ON."] }
                : { text_markup: "markdown", rules: ["Telegram rich OFF."] },
          },
        },
      },
    ]),
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  await state?.cleanup();
  state = undefined;
  resetSystemEventsForTest();
  resetPluginRuntimeStateForTest();
});

async function setup(label: string) {
  state = await createOpenClawTestState({ label, env: { OPENCLAW_TEST_FAST: "0" } });
  const storePath = path.join(state.root, "sessions.json");
  const cfg = withFullRuntimeReplyConfig({
    agents: {
      defaults: {
        workspace: state.workspaceDir,
        skipBootstrap: true,
        model: { primary: "mock-openai/gpt-5.6-luna" },
        models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
      },
    },
    channels: {
      telegram: {
        allowFrom: ["*"],
        accounts: { rich: { richMessages: true }, plain: { richMessages: false } },
      },
    },
    plugins: { enabled: false },
    session: { store: storePath },
  } as OpenClawConfig);
  await state.writeConfig(cfg);
  const runAgent = vi.spyOn(embeddedAgent, "runEmbeddedAgent").mockImplementation(async (p) => ({
    payloads: [{ text: "Status table ready." }],
    meta: {
      durationMs: 1,
      agentMeta: { sessionId: p.sessionId, provider: "mock-openai", model: "gpt-5.6-luna" },
    },
  }));
  const lastPrompt = () => runAgent.mock.calls.at(-1)?.[0].extraSystemPrompt ?? "";
  return { cfg, lastPrompt };
}

function expectContractOnce(prompt: string, markup: string) {
  expect(prompt.split("### Delivery Format")).toHaveLength(2);
  expect(prompt).toContain(`"text_markup": "${markup}"`);
}

it.each([["rich", "markdown_telegram_rich"]])(
  "gives a Telegram reply on the %s account its contract once",
  async (accountId, markup) => {
    const { cfg, lastPrompt } = await setup("reply-delivery-format");
    await getReplyFromConfig(
      finalizeInboundContext({
        Body: "Post the status table",
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:123",
        AccountId: accountId,
        ChatType: "direct",
        SessionKey: `agent:main:telegram:${accountId}:direct:123`,
      }),
      undefined,
      cfg,
    );
    expectContractOnce(lastPrompt(), markup);
  },
);

it("gives an event targeting Telegram the delivering account's contract once", async () => {
  const { cfg, lastPrompt } = await setup("event-delivery-format");
  await getReplyFromConfig(
    finalizeInboundContext({
      Body: "Reminder: post the status table",
      Provider: "internal",
      InternalTurnSource: "event",
      InputProvenance: { kind: "internal_system", sourceTool: "session-event" },
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:123",
      AccountId: "rich",
      ChatType: "direct",
      SessionKey: "agent:main:telegram:rich:direct:123",
    }),
    { internalEventExecution: { onStarted: () => {}, onTerminal: async () => {} } },
    cfg,
  );
  expectContractOnce(lastPrompt(), "markdown_telegram_rich");
});
