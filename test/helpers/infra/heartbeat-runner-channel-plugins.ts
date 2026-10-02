// Telegram heartbeat fixture preserves thread and reply routing for conversation tests.
import {
  resolveOutboundSendDep,
  type OutboundSendDeps,
} from "../../../src/infra/outbound/send-deps.js";
import { createOutboundTestPlugin } from "../../../src/test-utils/channel-plugins.js";
import { parseTelegramTargetForTest } from "./telegram-targets.js";

type HeartbeatSendFn = (
  to: string,
  text: string,
  opts?: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

function resolveSend(deps: unknown) {
  const send = resolveOutboundSendDep<HeartbeatSendFn>(deps as OutboundSendDeps, "telegram");
  if (!send) {
    throw new Error("Missing telegram outbound send dependency");
  }
  return send;
}

export const heartbeatRunnerTelegramPlugin = createOutboundTestPlugin({
  id: "telegram",
  label: "Telegram",
  docsPath: "/channels/telegram",
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ to, text, deps, cfg, accountId, replyToId, threadId, ...opts }) => {
      return (await resolveSend(deps)(to, text, {
        verbose: false,
        cfg,
        accountId,
        ...(typeof threadId === "number" ? { messageThreadId: threadId } : {}),
        ...(typeof replyToId === "string" ? { replyToMessageId: Number(replyToId) } : {}),
        ...(opts.silent !== undefined ? { silent: opts.silent } : {}),
      })) as never;
    },
    sendMedia: async ({ to, text, mediaUrl, deps, cfg, accountId, ...opts }) => {
      return (await resolveSend(deps)(to, text, {
        verbose: false,
        cfg,
        accountId,
        ...opts,
        mediaUrl,
      })) as never;
    },
  },
  messaging: {
    inferTargetChatType: ({ to }) => {
      const target = parseTelegramTargetForTest(to);
      return target.chatType === "unknown" ? undefined : target.chatType;
    },
    preserveHeartbeatThreadIdForGroupRoute: true,
  },
});
