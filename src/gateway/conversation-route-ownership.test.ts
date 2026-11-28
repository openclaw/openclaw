import { afterEach, describe, expect, it } from "vitest";
import type { ChannelMessagingAdapter } from "../channels/plugins/types.core.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { resolveConversationRouteEligibilitiesForAgent } from "./conversation-route-ownership.js";

type Conversation = Parameters<
  typeof resolveConversationRouteEligibilitiesForAgent
>[0]["conversations"][number];

function resolveRoute(config: OpenClawConfig, agentId: string, conversation: Conversation) {
  return resolveConversationRouteEligibilitiesForAgent({
    config,
    agentId,
    conversations: [conversation],
  });
}

const baseConversation = {
  conversationRef: "conv_11111111111111111111111111111111",
  accountId: "default",
  channel: "reef",
  kind: "group" as const,
  peerId: "topic-42",
  target: "group:topic-42",
};

function configWithPeer(id: string, teamId?: string): OpenClawConfig {
  return {
    agents: { entries: { main: {}, finance: {} } },
    bindings: [
      {
        type: "route",
        agentId: "finance",
        match: { channel: "reef", peer: { kind: "group", id }, ...(teamId ? { teamId } : {}) },
      },
      { type: "route", agentId: "main", match: { channel: "reef" } },
    ],
  };
}

describe("resolveConversationRouteEligibilitiesForAgent", () => {
  it("replays authoritative parent context when selecting the route owner", async () => {
    const config = configWithPeer("parent-room");
    const conversation = {
      ...baseConversation,
      routeContextObserved: true as const,
      routeContext: { parentPeerId: "parent-room" },
    };

    await expect(resolveRoute(config, "main", conversation)).resolves.toEqual(["denied"]);
    await expect(resolveRoute(config, "finance", conversation)).resolves.toEqual(["eligible"]);
  });

  it("does not treat an unrelated peer binding as a possible parent owner for a legacy thread", async () => {
    const config = configWithPeer("unrelated-room");

    await expect(
      resolveRoute(config, "main", { ...baseConversation, threadId: "topic-7" }),
    ).resolves.toEqual(["eligible"]);
  });

  it("replays a legacy thread parent binding from its retained route peer", async () => {
    const config = configWithPeer("parent-room");
    const conversation = { ...baseConversation, peerId: "parent-room", threadId: "topic-7" };

    await expect(resolveRoute(config, "main", conversation)).resolves.toEqual(["denied"]);
    await expect(resolveRoute(config, "finance", conversation)).resolves.toEqual(["eligible"]);
  });

  it("fails closed for a matching contextual wildcard when legacy context is absent", async () => {
    const config = configWithPeer("*", "finance");

    await expect(resolveRoute(config, "main", baseConversation)).resolves.toEqual(["denied"]);

    await expect(
      resolveRoute(config, "main", { ...baseConversation, routeContextObserved: true }),
    ).resolves.toEqual(["eligible"]);
  });
});

const pluginRouteConfig: OpenClawConfig = {
  agents: { entries: { main: {} } },
};

function bindingRecord(ref: {
  channel: string;
  accountId: string;
  conversationId: string;
}): SessionBindingRecord {
  return {
    bindingId: `reef:${ref.conversationId}`,
    targetSessionKey: `agent:main:reef:channel:${ref.conversationId}`,
    targetKind: "session",
    conversation: ref,
    status: "active",
    boundAt: 1,
  };
}

/**
 * Slack reads the prepared batch for the base conversation and again when the
 * thread reader aliases that base. Those calls must share one batch scan.
 */
function reefBatchReaders(): ChannelMessagingAdapter {
  return {
    async prepareConversationRouteOwnersAsync(inputs, inspectBindings) {
      const inspect = await inspectBindings(
        inputs.map((input) => ({
          channel: "reef",
          accountId: input.accountId,
          conversationId: input.conversation.peerId,
        })),
      );
      return inputs.map((_, position) => () => {
        const base = inspect()[position];
        const thread = inspect()[position];
        if (!base || !thread) {
          throw new Error("Reef binding owner returned an incomplete selection");
        }
        return { kind: "agent" as const, agentId: "main" };
      });
    },
  };
}

function installReefBatchReaders(adapter: SessionBindingAdapter) {
  registerSessionBindingAdapter(adapter);
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "reef",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "reef" }),
          messaging: reefBatchReaders(),
        },
      },
    ]),
  );
}

function reefConversation(peerId: string): Conversation {
  return {
    accountId: "default",
    channel: "reef",
    kind: "channel",
    peerId,
    target: `reef:${peerId}`,
  };
}

describe("prepared plugin route eligibility", () => {
  let adapter: SessionBindingAdapter | undefined;

  afterEach(() => {
    if (adapter) {
      unregisterSessionBindingAdapter({ channel: "reef", accountId: "default", adapter });
      adapter = undefined;
    }
    resetPluginRuntimeStateForTest();
  });

  async function resolveReef(conversations: readonly Conversation[]) {
    if (adapter) {
      unregisterSessionBindingAdapter({ channel: "reef", accountId: "default", adapter });
    }
    let scans = 0;
    adapter = {
      channel: "reef",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: (ref) => {
        scans += 1;
        return bindingRecord(ref);
      },
    };
    installReefBatchReaders(adapter);
    const eligibility = await resolveConversationRouteEligibilitiesForAgent({
      config: pluginRouteConfig,
      agentId: "main",
      conversations,
    });
    return { scans, eligibility };
  }

  it("scans each prepared binding batch once per eligibility pass", async () => {
    const small = await resolveReef(
      Array.from({ length: 16 }, (_, index) => reefConversation(`room-${index}`)),
    );
    const large = await resolveReef(
      Array.from({ length: 64 }, (_, index) => reefConversation(`room-${index}`)),
    );

    expect(small.eligibility).toEqual(Array.from({ length: 16 }, () => "eligible"));
    expect(large.eligibility).toEqual(Array.from({ length: 64 }, () => "eligible"));
    // Preparation classifies owners, then the read pass checks them again.
    // Each pass scans the batch once, including Slack's second read when the
    // thread aliases the base. Scanning once per row is quadratic: 16 rows did
    // 1,024 scans on the unfixed path.
    expect(small.scans).toBe(16 * 2);
    expect(large.scans).toBe(64 * 2);
    expect(large.scans / small.scans).toBe(4);
  });
});
