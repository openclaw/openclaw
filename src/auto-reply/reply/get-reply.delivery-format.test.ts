// Reply and heartbeat turns get the delivering Telegram account's formatting contract once.
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { heartbeatRunnerTelegramPlugin } from "../../../test/helpers/infra/heartbeat-runner-channel-plugins.js";
import * as embeddedAgent from "../../agents/embedded-agent.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runHeartbeatOnce } from "../../infra/heartbeat-runner.js";
import { seedMainSessionStore } from "../../infra/heartbeat-runner.test-utils.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "../../infra/system-events.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import { getReplyFromConfig } from "./get-reply.js";
import { finalizeInboundContext } from "./inbound-context.js";

let state: OpenClawTestState | undefined;
beforeEach(() => {
  resetSystemEventsForTest();
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        source: "test",
        plugin: {
          ...heartbeatRunnerTelegramPlugin,
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
        heartbeat: { every: "5m", target: "last" },
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
    payloads: [{ text: "HEARTBEAT_OK" }],
    meta: {
      durationMs: 1,
      agentMeta: { sessionId: p.sessionId, provider: "mock-openai", model: "gpt-5.6-luna" },
    },
  }));
  const lastPrompt = () => runAgent.mock.calls.at(-1)?.[0].extraSystemPrompt ?? "";
  return { cfg, storePath, lastPrompt };
}

function expectContractOnce(prompt: string, markup: string) {
  expect(prompt.split("### Delivery Format")).toHaveLength(2);
  expect(prompt).toContain(`"text_markup": "${markup}"`);
}

it.each([
  ["rich", "markdown_telegram_rich"],
  ["plain", "markdown"],
])("gives a Telegram reply on the %s account its contract once", async (accountId, markup) => {
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
});

it("gives no contract to a reply without a channel delivery target", async () => {
  const { cfg, lastPrompt } = await setup("reply-delivery-format-webchat");
  await getReplyFromConfig(
    finalizeInboundContext({
      Body: "Post the status table",
      Provider: "webchat",
      Surface: "webchat",
      ChatType: "direct",
      SessionKey: "agent:main:dashboard:format",
    }),
    undefined,
    cfg,
  );
  expect(lastPrompt()).not.toContain("### Delivery Format");
});

it("gives a heartbeat delivered to Telegram the delivering account's contract once", async () => {
  const { cfg, storePath, lastPrompt } = await setup("heartbeat-delivery-format");
  const sessionKey = await seedMainSessionStore(storePath, cfg, {
    lastChannel: "telegram",
    lastProvider: "telegram",
    lastTo: "-100155462274",
    lastAccountId: "rich",
  });
  enqueueSystemEvent("Reminder: post the status table", {
    sessionKey,
    contextKey: "cron:status",
  });
  const result = await runHeartbeatOnce({
    cfg,
    agentId: "main",
    sessionKey,
    source: "cron",
    reason: "cron:status",
    deps: { getReplyFromConfig },
  });
  expect(result.status).toBe("ran");
  expectContractOnce(lastPrompt(), "markdown_telegram_rich");
});
