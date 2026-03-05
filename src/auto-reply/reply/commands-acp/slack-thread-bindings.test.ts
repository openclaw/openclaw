import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  __testing as sessionBindingTesting,
  getSessionBindingService,
} from "../../../infra/outbound/session-binding-service.js";
import { createSlackThreadBindingManager } from "../../../../extensions/slack/src/monitor/thread-bindings.manager.js";
import { resetSlackThreadBindingsForTests } from "../../../../extensions/slack/src/monitor/thread-bindings.state.js";
import { buildCommandTestParams } from "../commands-spawn.test-harness.js";
import { resolveAcpCommandBindingContext } from "./context.js";
import { resolveBoundAcpThreadSessionKey } from "./targets.js";

vi.mock("../../../../extensions/slack/src/client.js", () => ({
  createSlackWebClient: () => ({
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ts: "8888888888.888888" }),
    },
  }),
}));

const baseCfg = {
  session: {
    mainKey: "main",
    scope: "per-sender",
    threadBindings: { enabled: true },
  },
  channels: {
    slack: {
      threadBindings: {
        enabled: true,
        spawnAcpSessions: true,
      },
    },
  },
} satisfies OpenClawConfig;

let manager: ReturnType<typeof createSlackThreadBindingManager>;

describe("slack ACP thread-binding integration", () => {
  beforeEach(() => {
    resetSlackThreadBindingsForTests();
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    manager = createSlackThreadBindingManager({
      accountId: "test-account",
      token: "xoxb-test",
      persist: false,
      enableSweeper: false,
    });
  });

  afterEach(() => {
    manager.stop();
    resetSlackThreadBindingsForTests();
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
  });

  describe("--thread here bind + lookup round-trip", () => {
    it("binds a Slack thread and resolves via resolveBoundAcpThreadSessionKey", async () => {
      // Simulate an existing Slack thread: thread_ts is the threadId, channel ID is the parent.
      const threadTs = "1709000000.000100";
      const channelId = "C_SLACK_CHAN";
      const sessionKey = "agent:test-account:acp:codex-abc";

      // Bind via manager (mirrors what bindSpawnedAcpSessionToThread does through the service).
      const service = getSessionBindingService();
      const binding = await service.bind({
        targetSessionKey: sessionKey,
        targetKind: "session",
        conversation: {
          channel: "slack",
          accountId: "test-account",
          conversationId: threadTs,
          parentConversationId: channelId,
        },
        placement: "current",
        metadata: { boundBy: "U_TESTER", agentId: "codex" },
      });
      expect(binding).not.toBeNull();

      // Now build ACP command params as if the user typed /acp status inside that Slack thread.
      const params = buildCommandTestParams("/acp status", baseCfg, {
        Provider: "slack",
        Surface: "slack",
        OriginatingChannel: "slack",
        AccountId: "test-account",
        MessageThreadId: threadTs,
        OriginatingTo: `channel:${channelId}`,
      });

      // Verify context resolution includes parentConversationId.
      const ctx = resolveAcpCommandBindingContext(params);
      expect(ctx.channel).toBe("slack");
      expect(ctx.threadId).toBe(threadTs);
      expect(ctx.parentConversationId).toBe(channelId);

      // The bound session key lookup should find the binding.
      const resolved = resolveBoundAcpThreadSessionKey(params);
      expect(resolved).toBe(sessionKey);
    });

    it("binds and resolves in a Slack DM thread via OriginatingConversationId", async () => {
      const threadTs = "1709000000.000300";
      const dmChannelId = "D_DM_CHAN";
      const sessionKey = "agent:test-account:acp:codex-dm";

      const service = getSessionBindingService();
      await service.bind({
        targetSessionKey: sessionKey,
        targetKind: "session",
        conversation: {
          channel: "slack",
          accountId: "test-account",
          conversationId: threadTs,
          parentConversationId: dmChannelId,
        },
        placement: "current",
        metadata: { boundBy: "U_DM_USER", agentId: "codex" },
      });

      // DM context: OriginatingTo is user:<id>, but OriginatingConversationId carries the D... channel.
      const params = buildCommandTestParams("/acp status", baseCfg, {
        Provider: "slack",
        Surface: "slack",
        OriginatingChannel: "slack",
        AccountId: "test-account",
        MessageThreadId: threadTs,
        OriginatingTo: "user:U_DM_USER",
        OriginatingConversationId: dmChannelId,
      });

      const ctx = resolveAcpCommandBindingContext(params);
      expect(ctx.parentConversationId).toBe(dmChannelId);

      const resolved = resolveBoundAcpThreadSessionKey(params);
      expect(resolved).toBe(sessionKey);
    });

    it("returns undefined when thread has no binding", () => {
      const params = buildCommandTestParams("/acp status", baseCfg, {
        Provider: "slack",
        Surface: "slack",
        OriginatingChannel: "slack",
        AccountId: "test-account",
        MessageThreadId: "1709000000.999999",
        OriginatingTo: "channel:C_OTHER",
      });

      const resolved = resolveBoundAcpThreadSessionKey(params);
      expect(resolved).toBeUndefined();
    });
  });

  describe("--thread auto child placement", () => {
    it("creates a child thread via service.bind and resolves it", async () => {
      const channelId = "C_PARENT";
      const sessionKey = "agent:test-account:acp:codex-child";

      // Bind via service with child placement (auto mode outside a thread).
      const service = getSessionBindingService();
      const binding = await service.bind({
        targetSessionKey: sessionKey,
        targetKind: "session",
        conversation: {
          channel: "slack",
          accountId: "test-account",
          conversationId: channelId,
          parentConversationId: channelId,
        },
        placement: "child",
        metadata: { boundBy: "U_TESTER", agentId: "codex", threadName: "Codex session" },
      });
      expect(binding).not.toBeNull();

      // The child binding creates a new thread — the adapter's bind() should have posted
      // a message to create the thread root. The returned binding's conversationId is the
      // new thread_ts (mocked as 8888888888.888888).
      const newThreadTs = binding.conversation.conversationId;
      expect(newThreadTs).toBe("8888888888.888888");

      // Resolve from within the new child thread.
      const found = service.resolveByConversation({
        channel: "slack",
        accountId: "test-account",
        conversationId: newThreadTs,
        parentConversationId: channelId,
      });
      expect(found).not.toBeNull();
      expect(found!.targetSessionKey).toBe(sessionKey);
    });
  });

  describe("parentConversationId is required for Slack lookups", () => {
    it("does not resolve without parentConversationId", async () => {
      const threadTs = "1709000000.000200";
      const channelId = "C_CHAN2";
      const sessionKey = "agent:test-account:acp:session-x";

      const service = getSessionBindingService();
      await service.bind({
        targetSessionKey: sessionKey,
        targetKind: "session",
        conversation: {
          channel: "slack",
          accountId: "test-account",
          conversationId: threadTs,
          parentConversationId: channelId,
        },
        placement: "current",
        metadata: { boundBy: "U1" },
      });

      // Lookup with correct parentConversationId succeeds.
      const found = service.resolveByConversation({
        channel: "slack",
        accountId: "test-account",
        conversationId: threadTs,
        parentConversationId: channelId,
      });
      expect(found).not.toBeNull();

      // Lookup with wrong parentConversationId fails (different channel).
      const notFound = service.resolveByConversation({
        channel: "slack",
        accountId: "test-account",
        conversationId: threadTs,
        parentConversationId: "C_WRONG_CHAN",
      });
      expect(notFound).toBeNull();
    });
  });
});
