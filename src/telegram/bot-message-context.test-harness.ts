import { vi } from "vitest";
import { buildTelegramMessageContext } from "./bot-message-context.js";

export const baseTelegramMessageContextConfig = {
  agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
  channels: { telegram: {} },
  messages: { groupChat: { mentionPatterns: [] } },
} as never;

type BuildTelegramMessageContextForTestParams = {
  message: Record<string, unknown>;
  options?: Record<string, unknown>;
  resolveGroupActivation?: () => boolean | undefined;
};

export async function buildTelegramMessageContextForTest(
  params: BuildTelegramMessageContextForTestParams,
): Promise<Awaited<ReturnType<typeof buildTelegramMessageContext>>> {
  return await buildTelegramMessageContext({
    primaryCtx: {
      message: {
        message_id: 1,
        date: 1_700_000_000,
        text: "hello",
        from: { id: 42, first_name: "Alice" },
        ...params.message,
      },
      me: { id: 7, username: "bot" },
    } as never,
    allMedia: [],
    storeAllowFrom: [],
    options: params.options ?? {},
    bot: {
      api: {
        sendChatAction: vi.fn(),
        setMessageReaction: vi.fn(),
      },
    } as never,
    cfg: baseTelegramMessageContextConfig,
    account: { accountId: "default" } as never,
    historyLimit: 0,
    groupHistories: new Map(),
    dmPolicy: "open",
    allowFrom: [],
    groupAllowFrom: [],
    ackReactionScope: "off",
    logger: { info: vi.fn() },
    resolveGroupActivation: params.resolveGroupActivation ?? (() => undefined),
    resolveGroupRequireMention: () => false,
    resolveTelegramGroupConfig: () => ({
      groupConfig: { requireMention: false },
      topicConfig: undefined,
    }),
  });
}
