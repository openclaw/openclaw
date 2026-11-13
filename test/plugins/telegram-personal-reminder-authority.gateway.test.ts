import { withRegisteredChannelIngress } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, expect, it, vi } from "vitest";
import { telegramPlugin } from "../../extensions/telegram/api.js";
import { setTelegramRuntime } from "../../extensions/telegram/runtime-api.js";
import {
  clearTelegramRuntimeForTest,
  loadTelegramHandlerAuthorizationForTest,
} from "../../extensions/telegram/test-api.js";
import { prepareInternalGetReplyOptions } from "../../src/auto-reply/reply/get-reply.types.js";
import { getRequesterProfile } from "../../src/auto-reply/requester-profile.js";
import { linkUserChannelIdentity } from "../../src/state/user-channel-identities.js";
import { publishCanonicalUserChannelPolicy } from "../../src/state/user-channel-identity-operations.js";
import { setUserProfileRole } from "../../src/state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../src/state/user-profiles.js";

const chatId = -1001234567890;
const topicId = 99;
const participantId = "42";
const groupConfig = { allowFrom: [participantId], groupPolicy: "allowlist" as const };
const telegram = {
  groupPolicy: "allowlist" as const,
  groupAllowFrom: [participantId],
  groups: { [String(chatId)]: groupConfig },
};

afterEach(clearRuntimeConfigSnapshot);
afterEach(clearTelegramRuntimeForTest);

it.each(["group", "direct"] as const)(
  "passes linked nonowner authority through registered Telegram %s ingress",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const testConfig: OpenClawConfig = {
        channels: {
          telegram: { ...telegram, dmPolicy: "open", allowFrom: [participantId] },
        },
        gateway: {
          roles: {
            default: "member",
            definitions: {
              member: { scopes: ["operator.write"], agents: "*", sessions: { others: "view" } },
            },
          },
        },
      };
      setRuntimeConfigSnapshot(testConfig);
      await publishCanonicalUserChannelPolicy(testConfig.gateway);
      const profile = ensureProfileForEmail("telegram-linked-reminder@example.test");
      setUserProfileRole(profile.id, "member");
      linkUserChannelIdentity(profile.id, {
        channelId: "telegram",
        accountId: "default",
        senderId: participantId,
      });
      const { createTelegramHandlerAuthorization } =
        await loadTelegramHandlerAuthorizationForTest();
      await withRegisteredChannelIngress(
        { plugin: telegramPlugin, config: testConfig, setRuntime: setTelegramRuntime },
        async (runtime) => {
          const isGroup = kind === "group";
          const actualChatId = isGroup ? chatId : Number(participantId);
          const authorization = createTelegramHandlerAuthorization({
            accountId: "default",
            ownerAgentId: "main",
            bot: {} as Parameters<typeof createTelegramHandlerAuthorization>[0]["bot"],
            cfg: testConfig,
            mediaMaxBytes: 1,
            opts: { token: "test-token" },
            runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
            telegramCfg: testConfig.channels!.telegram!,
            logger: getChildLogger({ module: "telegram/linked-role-test" }),
            resolveGroupPolicy: () => ({ allowlistEnabled: true, allowed: true }),
            resolveGroupActivation: () => undefined,
            resolveGroupRequireMention: () => false,
            resolveTelegramGroupConfig: () => ({ groupConfig, topicConfig: undefined }),
            shouldSkipUpdate: () => false,
            processMessage: async () => ({ kind: "completed" }),
          });
          const gate = await authorization.authorizeInboundMessage({
            msg: {
              message_id: 7,
              date: 1_700_000_000,
              chat: isGroup
                ? { id: actualChatId, type: "supergroup", title: "Forum", is_forum: true }
                : { id: actualChatId, type: "private", first_name: "Pat" },
              from: { id: Number(participantId), is_bot: false, first_name: "Pat" },
              ...(isGroup ? { message_thread_id: topicId } : {}),
              text: "remind me",
            },
            chatId: actualChatId,
            isGroup,
            isForum: isGroup,
            senderId: participantId,
            requireConfiguredGroup: false,
            dmAccess: "silent",
          });
          if (!gate.allowed) {
            throw new Error("expected linked sender admission");
          }
          const sessionKey = isGroup
            ? "agent:main:telegram:group:forum:topic:99"
            : "agent:main:telegram:direct:42";
          const ingress = await gate.resolveChannelIngress({
            agentId: "main",
            sessionKey,
            messageId: "7",
            inboundEventKind: "user_request",
          });
          const context = runtime.channel.inbound.buildContext({
            channel: "telegram",
            accountId: "default",
            messageId: "7",
            from: `telegram:${actualChatId}`,
            sender: { id: participantId },
            conversation: {
              kind: isGroup ? "group" : "direct",
              id: String(actualChatId),
              ...(isGroup ? { parentId: String(actualChatId), threadId: String(topicId) } : {}),
            },
            route: { agentId: "main", routeSessionKey: sessionKey },
            reply: {
              to: `telegram:${actualChatId}`,
              ...(isGroup ? { messageThreadId: topicId } : {}),
            },
            message: { rawBody: "remind me", inboundEventKind: "user_request" },
            channelIngress: ingress,
          });
          expect(getRequesterProfile(context)?.id).toBe(profile.id);
          const operator = prepareInternalGetReplyOptions(undefined, context)?.operatorAuthority;
          expect(operator?.profileId).toBe(profile.id);
          expect(operator?.scopes).toContain("operator.write");
          expect(operator?.scopes).not.toContain("operator.admin");
          expect(() => operator?.assertCurrent()).not.toThrow();
        },
      );
    });
  },
);
