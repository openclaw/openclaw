import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveAnnounceOrigin,
  resolveCompletionDeliveryOrigins,
  resolveGeneratedMediaSessionDeliveryRoute,
  resolveSubagentCompletionOrigin,
} from "../src/agents/subagents/announce/subagent-announce-origin.js";
import type { DeliveryContext } from "../src/agents/subagents/announce/subagent-announce-origin.js";
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

const requesterSessionKey = "agent:main:main";
const defaultChildSessionKey = "agent:worker:subagent:child";
const telegramChildKey = "agent:main:telegram:default:direct:123";
const registered = (plugin: ChannelPlugin) => ({ pluginId: plugin.id, source: "test", plugin });
const pluginWithMessaging = (id: string, messaging: ChannelPlugin["messaging"]) =>
  registered({ ...createChannelTestPluginBase({ id }), messaging });
const setPlugins = (...entries: NonNullable<Parameters<typeof createTestRegistry>[0]>) =>
  setActivePluginRegistry(createTestRegistry(entries));
function makeBinding(
  channel: string,
  conversationId: string,
  parentConversationId?: string,
  child = false,
) {
  return {
    channel,
    accountId: channel === "telegram" ? "bot-1" : "acct-1",
    targetSessionKey: child ? telegramChildKey : requesterSessionKey,
    targetKind: child ? ("subagent" as const) : ("session" as const),
    conversationId,
    parentConversationId,
  };
}
const discordRequester = {
  channel: "discord",
  accountId: "acct-1",
  to: "channel:requester-room",
  threadId: "requester-thread",
};
const telegramRequester = { channel: "telegram", accountId: "bot-1", to: "telegram:direct:123" };
type CompletionOrigins = Parameters<typeof resolveCompletionDeliveryOrigins>[0];
function expectDelivery(
  origins: CompletionOrigins,
  expected: DeliveryContext,
  route = { ...expected, chatType: "channel" },
) {
  expect(resolveCompletionDeliveryOrigins(origins).effectiveDirectOrigin).toEqual(expected);
  expect(
    resolveGeneratedMediaSessionDeliveryRoute({ sessionKey: requesterSessionKey, ...origins }),
  ).toEqual({ deliveryContext: expected, route });
}

afterEach(() => {
  sessionBindingServiceTesting.resetSessionBindingAdaptersForTests();
  setActivePluginRegistry(createTestRegistry());
});

function registerTestSessionBindings(
  channel: string,
  accountId: string,
  bindings: ReadonlyArray<ReturnType<typeof makeBinding>>,
): void {
  registerSessionBindingAdapter({
    channel,
    accountId,
    listBySession: (targetSessionKey) =>
      bindings
        .filter((binding) => binding.targetSessionKey === targetSessionKey)
        .map(({ targetSessionKey: boundKey, targetKind, ...conversation }) => ({
          bindingId: `${channel}:${accountId}:${conversation.conversationId}`,
          targetSessionKey: boundKey,
          targetKind,
          conversation,
          status: "active" as const,
          boundAt: 1,
        })),
    resolveByConversation: () => null,
  });
}

const foldedChatPlugin = pluginWithMessaging("folded-chat", {
  targetIdComparison: "lowercase",
}).plugin;

const topicConversationFixtures = new Map<string, { id: string; threadId: string }>([
  ["room-a:topic:99", { id: "room-a", threadId: "99" }],
  ["room-b:topic:99", { id: "room-b", threadId: "99" }],
]);

const storedTopic = (room: string) => ({
  lastChannel: "topicchat",
  lastTo: `topicchat:${room}:topic:99`,
  lastThreadId: 99,
});

describe("resolveAnnounceOrigin threaded route targets", () => {
  beforeEach(() => {
    setPlugins(
      pluginWithMessaging("topicchat", {
        resolveSessionConversation: ({ rawId }) => topicConversationFixtures.get(rawId) ?? null,
      }),
    );
  });

  it("does not inherit a target or thread from another account on the same channel", () => {
    const stored = {
      lastChannel: "telegram",
      lastTo: "peer-b",
      lastAccountId: "bot-b",
      lastThreadId: 99,
    };
    expect(
      resolveAnnounceOrigin(
        normalizeLegacySessionEntryDelivery(stored as unknown as SessionEntry),
        { channel: "telegram", accountId: "bot-a" },
      ),
    ).toEqual({ channel: "telegram", to: undefined, accountId: "bot-a" });
  });
  it.each([
    ["same chat", "room-a", "topicchat:room-a", 99],
    ["group-prefixed target", "room-a", "group:room-a", 99],
    ["different chat", "room-b", "topicchat:room-a", undefined],
  ] as const)("inherits a stored thread only for the %s", (_name, room, to, threadId) => {
    const requester = { channel: "topicchat", to };
    expect(
      resolveAnnounceOrigin(
        normalizeLegacySessionEntryDelivery(storedTopic(room) as unknown as SessionEntry),
        requester,
      ),
    ).toEqual(threadId === undefined ? requester : { ...requester, threadId });
  });
});

describe("resolveSubagentCompletionOrigin", () => {
  beforeEach(async () => {
    const { slackPlugin } = await loadBundledPluginFacade<{ slackPlugin: ChannelPlugin }>({
      pluginId: "slack",
      artifactBasename: "api.js",
    });
    setPlugins(
      registered(slackPlugin),
      registered(createChannelTestPluginBase({ id: "discord" })),
      registered(foldedChatPlugin),
      pluginWithMessaging("matrix", {
        targetIdComparison: "case-sensitive",
        resolveDeliveryTarget: ({ conversationId }: { conversationId: string }) => ({
          to: `room:${conversationId}`,
        }),
      }),
    );
  });

  it.each([
    ...["slack", "folded-chat"].map((channel) => ({
      name: `preserves a thread for case-folded ${channel} bound targets`,
      bindings: [makeBinding(channel, "C123")],
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
    })),
    {
      name: "retargets distinct case-sensitive bound conversation ids",
      bindings: [makeBinding("matrix", "!room:server")],
      requesterOrigin: { channel: "matrix", accountId: "acct-1", to: "channel:!Room:server" },
      expected: { channel: "matrix", accountId: "acct-1", to: "room:!room:server" },
    },
    ...(
      [
        ["another room", "bound-room", undefined, "bound-room", undefined],
        ["same room", "requester-room", undefined, "requester-room", "requester-thread"],
        ["requester thread", "requester-thread", undefined, "requester-room", "requester-thread"],
        ["bound child thread", "bound-thread", "bound-room", "bound-thread", "bound-thread"],
      ] as const
    ).map(([name, conversationId, parentConversationId, to, threadId]) => ({
      name: `routes a binding for ${name}`,
      bindings: [makeBinding("discord", conversationId, parentConversationId)],
      requesterOrigin: discordRequester,
      expected: {
        channel: "discord",
        accountId: "acct-1",
        to: `channel:${to}`,
        ...(threadId ? { threadId } : {}),
      },
    })),
    {
      name: "prefers requester binding when child and requester share the same channel and accountId",
      bindings: [
        makeBinding("telegram", "direct:123", undefined, true),
        makeBinding("telegram", "direct:789"),
      ],
      childSessionKey: telegramChildKey,
      requesterOrigin: { ...telegramRequester, to: "telegram:direct:789" },
      expected: { ...telegramRequester, to: "telegram:direct:789" },
      spawnMode: "run" as const,
    },
    {
      name: "falls back to child binding when requester has no binding",
      bindings: [makeBinding("telegram", "direct:123", undefined, true)],
      childSessionKey: telegramChildKey,
      requesterOrigin: telegramRequester,
      expected: telegramRequester,
      spawnMode: "run" as const,
    },
  ])("$name", async ({ bindings, requesterOrigin, expected, name: _name, ...options }) => {
    const first = bindings[0];
    if (first) {
      registerTestSessionBindings(first.channel, first.accountId, bindings);
    }

    const origin = await resolveSubagentCompletionOrigin({
      childSessionKey: defaultChildSessionKey,
      requesterSessionKey,
      requesterOrigin,
      spawnMode: "session",
      ...options,
      expectsCompletionMessage: true,
    });

    expect(origin).toEqual(expected);
    expectDelivery(
      {
        expectsCompletionMessage: true,
        completionDirectOrigin: origin,
        directOrigin: requesterOrigin,
        requesterSessionOrigin: requesterOrigin,
      },
      expected,
      {
        ...expected,
        chatType: ["telegram", "matrix"].includes(expected.channel) ? "direct" : "channel",
      },
    );
  });
});

describe("completion delivery route fallback", () => {
  type MediaRoute = ReturnType<typeof resolveGeneratedMediaSessionDeliveryRoute>["route"];
  type CompletionRouteCase = Omit<CompletionOrigins, "expectsCompletionMessage"> & {
    name: string;
    expected: DeliveryContext;
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
    setPlugins(
      pluginWithMessaging("slack", {
        normalizeTarget: (to: string) => `channel:${to.toLowerCase()}`,
      }),
      registered(telegramPlugin),
      registered(foldedChatPlugin),
      pluginWithMessaging("scoped-chat", {
        targetIdComparison: "lowercase",
        resolveSessionConversation: ({ rawId }: { rawId: string }) =>
          scopedConversationFixtures.get(rawId) ?? null,
      }),
    );
  });

  const requesterSessionOrigin = { ...discordRequester, channel: "slack" };
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
    ...["same", "different-port"].map((destination) => {
      const opaqueOrigin = {
        channel: "matrix",
        to: "room:!example:topic:100",
        threadId: "$reply",
      };
      const to = destination === "same" ? opaqueOrigin.to : "room:!example:topic:101";
      return {
        name: `an opaque Matrix room with ${destination} identity`,
        requesterSessionOrigin: opaqueOrigin,
        directOrigin: opaqueOrigin,
        completionDirectOrigin: { to },
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
      name: "a partial completion origin",
      completionDirectOrigin: { channel: "slack" },
      expected: requesterSessionOrigin,
    },
    {
      name: "a to-only completion origin for the same target",
      completionDirectOrigin: { to: requesterSessionOrigin.to },
      expected: requesterSessionOrigin,
    },
  ])(
    "uses $name for completion and generated-media delivery",
    ({ name: _name, expected, expectedChatType = "channel", expectedRoute, ...override }) => {
      const origins = { directOrigin: requesterSessionOrigin, requesterSessionOrigin, ...override };
      expectDelivery(
        { ...origins, expectsCompletionMessage: true },
        expected,
        expectedRoute ?? { ...expected, chatType: expectedChatType },
      );
    },
  );
});
