import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveAnnounceOrigin,
  resolveCompletionDeliveryOrigins,
  resolveGeneratedMediaSessionDeliveryRoute,
  resolveSubagentCompletionOrigin,
} from "../src/agents/subagents/announce/subagent-announce-origin.js";
import type { ChannelPlugin } from "../src/channels/plugins/types.plugin.js";
import type { SessionEntry } from "../src/config/sessions.js";
import {
  testing as sessionBindingServiceTesting,
  registerSessionBindingAdapter,
} from "../src/infra/outbound/session-binding-service.js";
import { normalizeLegacySessionEntryDelivery } from "../src/infra/state-migrations.legacy-session-store.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
import { loadBundledPluginFacade } from "../src/test-utils/bundled-plugin-public-surface.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../src/test-utils/channel-plugins.js";

afterEach(() => {
  sessionBindingServiceTesting.resetSessionBindingAdaptersForTests();
  setActivePluginRegistry(createTestRegistry());
});

function registerTestSessionBindings(
  channel: string,
  accountId: string,
  bindings: ReadonlyArray<{
    targetSessionKey: string;
    targetKind: "session" | "subagent";
    conversationId: string;
    parentConversationId?: string;
  }>,
): void {
  registerSessionBindingAdapter({
    channel,
    accountId,
    listBySession: (targetSessionKey) =>
      bindings
        .filter((binding) => binding.targetSessionKey === targetSessionKey)
        .map((binding) => ({
          bindingId: `${channel}:${accountId}:${binding.conversationId}`,
          targetSessionKey,
          targetKind: binding.targetKind,
          conversation: {
            channel,
            accountId,
            conversationId: binding.conversationId,
            parentConversationId: binding.parentConversationId,
          },
          status: "active" as const,
          boundAt: 1,
        })),
    resolveByConversation: () => null,
  });
}

const foldedChatPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({ id: "folded-chat" }),
  messaging: { targetIdComparison: "lowercase" },
};

const topicConversationFixtures = new Map<string, { id: string; threadId: string }>([
  ["room-a:topic:99", { id: "room-a", threadId: "99" }],
  ["room-b:topic:99", { id: "room-b", threadId: "99" }],
]);

const resolveFixtureTopicConversation = ({ rawId }: { rawId: string }) =>
  topicConversationFixtures.get(rawId) ?? null;

describe("resolveAnnounceOrigin threaded route targets", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "topicchat",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "topicchat" }),
            messaging: { resolveSessionConversation: resolveFixtureTopicConversation },
          },
        },
      ]),
    );
  });

  it.each([
    {
      name: "does not inherit a target or thread from another account on the same channel",
      stored: {
        lastChannel: "telegram",
        lastTo: "peer-b",
        lastAccountId: "bot-b",
        lastThreadId: 99,
      },
      requester: { channel: "telegram", accountId: "bot-a" },
      expected: { channel: "telegram", to: undefined, accountId: "bot-a" },
    },
    {
      name: "preserves stored thread ids when requester origin omits one for the same chat",
      stored: {
        lastChannel: "topicchat",
        lastTo: "topicchat:room-a:topic:99",
        lastThreadId: 99,
      },
      requester: { channel: "topicchat", to: "topicchat:room-a" },
      expected: { channel: "topicchat", to: "topicchat:room-a", threadId: 99 },
    },
    {
      name: "preserves stored thread ids for group-prefixed requester targets",
      stored: {
        lastChannel: "topicchat",
        lastTo: "topicchat:room-a:topic:99",
        lastThreadId: 99,
      },
      requester: { channel: "topicchat", to: "group:room-a" },
      expected: { channel: "topicchat", to: "group:room-a", threadId: 99 },
    },
    {
      name: "still strips stale thread ids when the stored route points at a different chat",
      stored: {
        lastChannel: "topicchat",
        lastTo: "topicchat:room-b:topic:99",
        lastThreadId: 99,
      },
      requester: { channel: "topicchat", to: "topicchat:room-a" },
      expected: { channel: "topicchat", to: "topicchat:room-a" },
    },
  ])("$name", ({ stored, requester, expected }) => {
    expect(
      resolveAnnounceOrigin(
        normalizeLegacySessionEntryDelivery(stored as unknown as SessionEntry),
        requester,
      ),
    ).toEqual(expected);
  });
});

describe("resolveSubagentCompletionOrigin", () => {
  beforeEach(async () => {
    const { slackPlugin } = await loadBundledPluginFacade<{ slackPlugin: ChannelPlugin }>({
      pluginId: "slack",
      artifactBasename: "api.js",
    });
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "slack", source: "test", plugin: slackPlugin },
        {
          pluginId: "discord",
          source: "test",
          plugin: createChannelTestPluginBase({ id: "discord" }),
        },
        { pluginId: "folded-chat", source: "test", plugin: foldedChatPlugin },
        {
          pluginId: "matrix",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "matrix" }),
            messaging: {
              targetIdComparison: "case-sensitive",
              resolveDeliveryTarget: ({ conversationId }: { conversationId: string }) => ({
                to: `room:${conversationId}`,
              }),
            },
          },
        },
      ]),
    );
  });

  it.each([
    ...["slack", "folded-chat"].map((channel) => ({
      name: `preserves a thread for case-folded ${channel} bound targets`,
      bindings: [
        {
          channel,
          accountId: "acct-1",
          targetSessionKey: "agent:main:main",
          targetKind: "session" as const,
          conversationId: "C123",
        },
      ],
      childSessionKey: "agent:worker:subagent:child",
      requesterOrigin: {
        channel,
        accountId: "acct-1",
        to: "channel:c123",
        threadId: "reply-1",
      },
      expected: {
        channel,
        accountId: "acct-1",
        to: channel === "slack" ? "channel:c123" : "channel:C123",
        threadId: "reply-1",
      },
      spawnMode: "session" as const,
    })),
    {
      name: "retargets distinct case-sensitive bound conversation ids",
      bindings: [
        {
          channel: "matrix",
          accountId: "acct-1",
          targetSessionKey: "agent:main:main",
          targetKind: "session" as const,
          conversationId: "!room:server",
        },
      ],
      childSessionKey: "agent:worker:subagent:child",
      requesterOrigin: { channel: "matrix", accountId: "acct-1", to: "channel:!Room:server" },
      expected: { channel: "matrix", accountId: "acct-1", to: "room:!room:server" },
      spawnMode: "session" as const,
    },
    ...[
      {
        name: "drops the requester thread when a binding selects another top-level conversation",
        conversationId: "bound-room",
        expected: { to: "channel:bound-room" },
      },
      {
        name: "preserves the requester thread when a binding stays in the same room",
        conversationId: "requester-room",
        expected: { to: "channel:requester-room", threadId: "requester-thread" },
      },
      {
        name: "preserves the requester target when its thread is the bound conversation",
        conversationId: "requester-thread",
        expected: { to: "channel:requester-room", threadId: "requester-thread" },
      },
      {
        name: "uses the bound child thread instead of the requester thread",
        conversationId: "bound-thread",
        parentConversationId: "bound-room",
        expected: { to: "channel:bound-thread", threadId: "bound-thread" },
      },
    ].map(({ name, conversationId, parentConversationId, expected }) => ({
      name,
      bindings: [
        {
          channel: "discord",
          accountId: "acct-1",
          targetSessionKey: "agent:main:main",
          targetKind: "session" as const,
          conversationId,
          parentConversationId,
        },
      ],
      childSessionKey: "agent:worker:subagent:child",
      requesterOrigin: {
        channel: "discord",
        accountId: "acct-1",
        to: "channel:requester-room",
        threadId: "requester-thread",
      },
      expected: { channel: "discord", accountId: "acct-1", ...expected },
      spawnMode: "session" as const,
    })),
    {
      name: "resolves bound completion delivery from the requester session, not the child session",
      bindings: [
        {
          channel: "discord",
          accountId: "bot-alpha",
          targetSessionKey: "agent:worker:subagent:child",
          targetKind: "subagent" as const,
          conversationId: "child-window",
        },
        {
          channel: "discord",
          accountId: "acct-1",
          targetSessionKey: "agent:main:main",
          targetKind: "session" as const,
          conversationId: "parent-main",
        },
      ],
      childSessionKey: "agent:worker:subagent:child",
      requesterOrigin: {
        channel: "discord",
        accountId: "acct-1",
        to: "channel:parent-main",
      },
      expected: { channel: "discord", accountId: "acct-1", to: "channel:parent-main" },
      spawnMode: "session" as const,
    },
    {
      name: "prefers requester binding when child and requester share the same channel and accountId",
      bindings: [
        {
          channel: "telegram",
          accountId: "bot-1",
          targetSessionKey: "agent:main:telegram:default:direct:123",
          targetKind: "subagent" as const,
          conversationId: "direct:123",
        },
        {
          channel: "telegram",
          accountId: "bot-1",
          targetSessionKey: "agent:main:main",
          targetKind: "session" as const,
          conversationId: "direct:789",
        },
      ],
      childSessionKey: "agent:main:telegram:default:direct:123",
      requesterOrigin: {
        channel: "telegram",
        accountId: "bot-1",
        to: "telegram:direct:789",
      },
      expected: { channel: "telegram", accountId: "bot-1", to: "telegram:direct:789" },
      spawnMode: "run" as const,
    },
    {
      name: "falls back to child binding when requester has no binding",
      bindings: [
        {
          channel: "telegram",
          accountId: "bot-1",
          targetSessionKey: "agent:main:telegram:default:direct:123",
          targetKind: "subagent" as const,
          conversationId: "direct:123",
        },
      ],
      childSessionKey: "agent:main:telegram:default:direct:123",
      requesterOrigin: {
        channel: "telegram",
        accountId: "bot-1",
        to: "telegram:direct:123",
      },
      expected: { channel: "telegram", accountId: "bot-1", to: "telegram:direct:123" },
      spawnMode: "run" as const,
    },
  ])("$name", async ({ bindings, childSessionKey, requesterOrigin, expected, spawnMode }) => {
    const bindingGroups = new Map<string, (typeof bindings)[number][]>();
    for (const binding of bindings) {
      const key = `${binding.channel}\0${binding.accountId}`;
      const group = bindingGroups.get(key) ?? [];
      group.push(binding);
      bindingGroups.set(key, group);
    }
    for (const group of bindingGroups.values()) {
      const binding = group[0];
      if (binding) {
        registerTestSessionBindings(binding.channel, binding.accountId, group);
      }
    }

    const origin = await resolveSubagentCompletionOrigin({
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterOrigin,
      spawnMode,
      expectsCompletionMessage: true,
    });

    const { effectiveDirectOrigin } = resolveCompletionDeliveryOrigins({
      expectsCompletionMessage: true,
      completionDirectOrigin: origin,
      directOrigin: requesterOrigin,
      requesterSessionOrigin: requesterOrigin,
    });
    expect({
      origin,
      effectiveDirectOrigin,
      media: resolveGeneratedMediaSessionDeliveryRoute({
        sessionKey: "agent:main:main",
        completionDirectOrigin: origin,
        directOrigin: requesterOrigin,
        requesterSessionOrigin: requesterOrigin,
      }),
    }).toEqual({
      origin: expected,
      effectiveDirectOrigin: expected,
      media: {
        deliveryContext: expected,
        route: {
          ...expected,
          chatType: ["telegram", "matrix"].includes(expected.channel) ? "direct" : "channel",
        },
      },
    });
  });
});

describe("completion delivery route fallback", () => {
  type MediaRoute = ReturnType<typeof resolveGeneratedMediaSessionDeliveryRoute>["route"];
  type CompletionRouteCase = Omit<
    Parameters<typeof resolveCompletionDeliveryOrigins>[0],
    "expectsCompletionMessage"
  > & {
    name: string;
    expected: NonNullable<
      ReturnType<typeof resolveCompletionDeliveryOrigins>["effectiveDirectOrigin"]
    >;
    expectedChatType?: MediaRoute["chatType"];
    expectedRoute?: MediaRoute;
  };

  const scopedConversationFixtures = new Map([
    ["alias-a", { id: "room:topic:root:sender:a", baseConversationId: "room" }],
    ["alias-b", { id: "room:topic:root:sender:b", baseConversationId: "room" }],
    ["alias-upper", { id: "room:topic:root:sender:A", baseConversationId: "room" }],
    ["room:topic:root:sender:a", { id: "room:topic:root:sender:a", baseConversationId: "room" }],
  ]);

  beforeEach(async () => {
    const { telegramPlugin } = await loadBundledPluginFacade<{ telegramPlugin: ChannelPlugin }>({
      pluginId: "telegram",
      artifactBasename: "api.js",
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "slack" }),
            messaging: { normalizeTarget: (to: string) => `channel:${to.toLowerCase()}` },
          },
        },
        {
          pluginId: "telegram",
          source: "test",
          plugin: telegramPlugin,
        },
        { pluginId: "folded-chat", source: "test", plugin: foldedChatPlugin },
        {
          pluginId: "scoped-chat",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "scoped-chat" }),
            messaging: {
              targetIdComparison: "lowercase",
              resolveSessionConversation: ({ rawId }: { rawId: string }) =>
                scopedConversationFixtures.get(rawId) ?? null,
            },
          },
        },
      ]),
    );
  });

  const requesterSessionOrigin = {
    channel: "slack",
    accountId: "acct-1",
    to: "channel:requester-room",
    threadId: "requester-thread",
  };
  const retargetedOrigin = { channel: "slack", accountId: "acct-1", to: "channel:bound-room" };
  const topicOrigin = {
    channel: "telegram",
    accountId: "bot-1",
    to: "telegram:123:topic:99",
    threadId: 99,
  };
  const retargetedTopic = { channel: "telegram", accountId: "bot-1", to: "telegram:123:topic:100" };

  it.each<CompletionRouteCase>([
    ...["completionDirectOrigin", "directOrigin"].map((field) => ({
      name: `a case-folded ${field} target`,
      directOrigin: { channel: "folded-chat", to: "channel:c123", threadId: "reply-1" },
      requesterSessionOrigin: { channel: "folded-chat", to: "channel:c123", threadId: "reply-1" },
      [field]: { channel: "folded-chat", to: "channel:C123" },
      expected: { channel: "folded-chat", to: "channel:C123", threadId: "reply-1" },
    })),
    ...[
      {
        name: "a to-only override to another topic",
        completionDirectOrigin: { to: retargetedTopic.to },
        expected: retargetedTopic,
      },
      {
        name: "a direct origin retargeted to another topic",
        directOrigin: retargetedTopic,
        expected: retargetedTopic,
      },
      {
        name: "an explicit primary thread on a topic-qualified target",
        completionDirectOrigin: { ...retargetedTopic, threadId: 100 },
        expected: { ...retargetedTopic, threadId: 100 },
        expectedRoute: { ...retargetedTopic, threadId: "100", chatType: "direct" as const },
      },
      {
        name: "an unqualified target in the same topic's room",
        completionDirectOrigin: { to: "telegram:123" },
        expected: { ...topicOrigin, to: "telegram:123" },
        expectedRoute: {
          ...topicOrigin,
          to: "telegram:123",
          threadId: "99",
          chatType: "direct" as const,
        },
      },
    ].map((scenario) =>
      Object.assign(
        {
          directOrigin: topicOrigin,
          requesterSessionOrigin: topicOrigin,
          expectedChatType: "direct" as const,
        },
        scenario,
      ),
    ),
    ...["same", "different-port", "shorter"].map((destination) => {
      const opaqueOrigin = {
        channel: "matrix",
        to: "room:!example:topic:100",
        threadId: "$reply",
      };
      const to =
        destination === "same"
          ? opaqueOrigin.to
          : destination === "shorter"
            ? "room:!example"
            : "room:!example:topic:101";
      return {
        name: `an opaque Matrix room with ${destination} identity`,
        requesterSessionOrigin: opaqueOrigin,
        directOrigin: opaqueOrigin,
        completionDirectOrigin: {
          to,
        },
        expected: destination === "same" ? opaqueOrigin : { channel: "matrix", to },
        expectedChatType: "direct" as const,
      };
    }),
    ...[false, true].map((retargeted) => {
      const scopedOrigin = {
        channel: "scoped-chat",
        to: "room:topic:root:sender:a",
        threadId: "reply-a",
      };
      const to = retargeted ? "alias-b" : "alias-a";
      return {
        name: retargeted ? "a different scoped identity with the same parent" : "a scoped alias",
        requesterSessionOrigin: scopedOrigin,
        directOrigin: scopedOrigin,
        completionDirectOrigin: { to },
        expected: retargeted ? { channel: "scoped-chat", to } : { ...scopedOrigin, to },
        expectedChatType: "direct" as const,
      };
    }),
    {
      name: "a case-distinct canonical identity on a channel with folded target ids",
      directOrigin: { channel: "scoped-chat", to: "alias-a", threadId: "reply-a" },
      requesterSessionOrigin: { channel: "scoped-chat", to: "alias-a", threadId: "reply-a" },
      completionDirectOrigin: { channel: "scoped-chat", to: "alias-upper" },
      expected: { channel: "scoped-chat", to: "alias-upper" },
      expectedChatType: "direct",
    },
    {
      name: "a retargeted completion override",
      completionDirectOrigin: retargetedOrigin,
      expected: retargetedOrigin,
    },
    {
      name: "a retargeted direct origin",
      directOrigin: retargetedOrigin,
      expected: retargetedOrigin,
    },
    {
      name: "a partial completion origin",
      completionDirectOrigin: { channel: "slack" },
      expected: requesterSessionOrigin,
    },
    {
      name: "a to-only completion origin for the same target",
      completionDirectOrigin: { to: requesterSessionOrigin.to },
      expected: requesterSessionOrigin,
    },
    {
      name: "a to-only completion origin for a different target",
      completionDirectOrigin: { to: retargetedOrigin.to },
      expected: retargetedOrigin,
    },
    {
      name: "an explicit completion thread",
      completionDirectOrigin: { ...retargetedOrigin, threadId: "bound-thread" },
      expected: { ...retargetedOrigin, threadId: "bound-thread" },
    },
  ])(
    "uses $name for completion and generated-media delivery",
    ({ name: _name, expected, expectedChatType = "channel", expectedRoute, ...override }) => {
      const origins = { directOrigin: requesterSessionOrigin, requesterSessionOrigin, ...override };
      expect(
        resolveCompletionDeliveryOrigins({ ...origins, expectsCompletionMessage: true })
          .effectiveDirectOrigin,
      ).toEqual(expected);
      expect(
        resolveGeneratedMediaSessionDeliveryRoute({ sessionKey: "agent:main:main", ...origins }),
      ).toEqual({
        deliveryContext: expected,
        route: expectedRoute ?? { ...expected, chatType: expectedChatType },
      });
    },
  );
});
