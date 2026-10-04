// Cron announce runs receive the delivery channel's formatting hints as trusted system metadata.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { mockCall } from "../../test-utils/mock-call-assertions.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { resolveCronDeliveryContext } from "./run-delivery-trace.js";
import {
  clearFastTestEnv,
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronDeliveryPlanMock,
  resolveDeliveryTargetMock,
  restoreFastTestEnv,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

const cfg = {
  channels: {
    telegram: {
      accounts: {
        rich: { richMessages: true },
        plain: { richMessages: false },
      },
    },
  },
} as OpenClawConfig;

// The Telegram plugin is not active: the first announcement after startup bootstraps it
// into a caller-owned registry, like a cold Gateway.
const { bootstrapOutboundChannelPluginMock } = vi.hoisted(() => ({
  bootstrapOutboundChannelPluginMock: vi.fn(),
}));
vi.mock("../../infra/outbound/channel-bootstrap.runtime.js", () => ({
  bootstrapOutboundChannelPlugin: bootstrapOutboundChannelPluginMock,
  bootstrapOutboundChannelPluginAsync: bootstrapOutboundChannelPluginMock,
}));

function bootstrapTelegramWithFormattingHints() {
  bootstrapOutboundChannelPluginMock.mockReturnValue(
    createTestRegistry([
      {
        pluginId: "telegram",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({
            id: "telegram",
            label: "Telegram",
            config: {
              listAccountIds: (config: OpenClawConfig) =>
                Object.keys(config.channels?.telegram?.accounts ?? {}),
            },
          }),
          outbound: { deliveryMode: "direct", sendText: async () => ({ messageId: "1" }) },
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
}

type EmbeddedRunFormatting = {
  extraSystemPrompt?: string;
  finalizePromptForResolvedTools?: (params: {
    prompt: string;
    messageToolAvailable: boolean;
  }) => string;
};

async function runCron(delivery: Record<string, unknown>, accountId?: string) {
  mockRunCronFallbackPassthrough();
  resolveCronDeliveryPlanMock.mockReturnValue({
    requested: delivery.mode === "announce",
    ...delivery,
  });
  resolveDeliveryTargetMock.mockResolvedValue({
    ok: true,
    channel: "telegram",
    to: "-100123",
    accountId,
    threadId: 7,
    mode: "explicit",
  });
  await runCronIsolatedAgentTurn(
    makeIsolatedAgentParamsFixture({
      cfg,
      job: makeIsolatedAgentJobFixture({
        id: "daily-digest",
        name: "Daily digest",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "agentTurn", message: "post the digest" },
        delivery,
      }),
      message: "post the digest",
      sessionKey: "cron:daily-digest",
    }),
  );
  const run = mockCall(runEmbeddedAgentMock)[0] as EmbeddedRunFormatting;
  const finalize = (messageToolAvailable: boolean) =>
    run.finalizePromptForResolvedTools?.({ prompt: "post the digest", messageToolAvailable });
  return { prompt: run.extraSystemPrompt, finalize };
}

describe("runCronIsolatedAgentTurn delivery formatting hints", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();
    resetPluginRuntimeStateForTest();
    bootstrapTelegramWithFormattingHints();
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
    resetPluginRuntimeStateForTest();
  });

  it.each([
    { accountId: "rich", markup: "markdown_telegram_rich", rule: "Telegram rich ON." },
    { accountId: "plain", markup: "markdown", rule: "Telegram rich OFF." },
  ])(
    "gives an announce run the $accountId account's formatting contract",
    async ({ accountId, markup, rule }) => {
      const { prompt } = await runCron(
        { mode: "announce", channel: "telegram", to: "-100123", accountId },
        accountId,
      );
      expect(prompt?.split("### Delivery Format")).toHaveLength(2);
      expect(prompt).toContain('"schema": "openclaw.delivery_format.v1"');
      expect(prompt).toContain(`"text_markup": "${markup}"`);
      expect(prompt).toContain(rule);
    },
  );

  it.each(["plain", undefined])(
    "adds message-tool formatting only for an unambiguous account (%s) and available tool",
    async (accountId) => {
      const { prompt, finalize } = await runCron(
        { mode: "none", channel: "telegram", to: "-100123", ...(accountId ? { accountId } : {}) },
        accountId,
      );
      expect(prompt).toBeUndefined();
      if (accountId) {
        const withTool = finalize(true);
        expect(withTool?.split("### Delivery Format")).toHaveLength(2);
        expect(withTool).toContain("with the message tool");
        expect(withTool).toContain("Telegram rich OFF.");
      } else {
        expect(finalize(true)).not.toContain("### Delivery Format");
      }
      expect(finalize(false)).not.toContain("### Delivery Format");
    },
  );

  it("uses the scheduled owner's account, which the message tool sends through", async () => {
    const ownerSessionKey = "agent:main:telegram:group:-100123";
    const delivery = { mode: "none", channel: "telegram", to: "-100123" };
    resolveCronDeliveryPlanMock.mockReturnValue({ requested: false, ...delivery });
    resolveDeliveryTargetMock.mockResolvedValue({
      ok: true,
      channel: "telegram",
      to: "-100123",
      accountId: "plain",
      mode: "explicit",
    });
    const context = await resolveCronDeliveryContext({
      cfg,
      agentId: "main",
      job: makeIsolatedAgentJobFixture({
        id: "daily-digest",
        name: "Daily digest",
        schedule: { kind: "every", everyMs: 60_000 },
        owner: { agentId: "main", sessionKey: ownerSessionKey, accountId: "rich" },
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey,
          ownerAccountId: "rich",
        },
        payload: { kind: "agentTurn", message: "post the digest", toolsAllow: ["message"] },
        delivery,
      }),
    });

    expect(context.messageToolFormatPrompt).toContain("Telegram rich ON.");
  });
});
