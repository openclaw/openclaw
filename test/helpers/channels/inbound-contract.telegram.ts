import { it } from "vitest";
import { expectChannelInboundContextContract } from "../../../src/channels/plugins/contracts/test-helpers.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { resolveRelativeBundledPluginPublicModuleId } from "../../../src/test-utils/bundled-plugin-public-surface.js";

const telegramHarnessModuleId = resolveRelativeBundledPluginPublicModuleId({
  fromModuleUrl: import.meta.url,
  pluginId: "telegram",
  artifactBasename: "src/bot-message-context.test-harness.js",
});

async function buildTelegramMessageContextForTest(params: {
  cfg: OpenClawConfig;
  message: Record<string, unknown>;
}) {
  const telegramHarnessModule = (await import(telegramHarnessModuleId)) as {
    buildTelegramMessageContextForTest: (params: {
      cfg: OpenClawConfig;
      message: Record<string, unknown>;
    }) => Promise<
      { ctxPayload: import("../../../src/auto-reply/templating.js").MsgContext } | null | undefined
    >;
  };
  return await telegramHarnessModule.buildTelegramMessageContextForTest(params);
}

export function installTelegramInboundContractSuite() {
  it("keeps inbound context finalized", async () => {
    const context = await buildTelegramMessageContextForTest({
      cfg: {
        agents: {
          defaults: {
            envelopeTimezone: "utc",
          },
        },
        channels: {
          telegram: {
            groupPolicy: "open",
            groups: { "*": { requireMention: false } },
          },
        },
      } satisfies OpenClawConfig,
      message: {
        chat: { id: 42, type: "group", title: "Ops" },
        text: "hello",
        date: 1736380800,
        message_id: 2,
        from: {
          id: 99,
          first_name: "Ada",
          last_name: "Lovelace",
          username: "ada",
        },
      },
    });

    const payload = context?.ctxPayload;
    if (!payload) {
      throw new Error("expected telegram inbound payload");
    }
    expectChannelInboundContextContract(payload);
  });
}
