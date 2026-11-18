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
const destination = (channel: string, to: string, threadId?: string) => ({
  channel,
  to,
  ...(threadId === undefined ? {} : { threadId }),
});
const discordRequester = {
  ...destination("discord", "channel:requester-room", "requester-thread"),
  accountId: "acct-1",
};
const telegramRequester = { ...destination("telegram", "telegram:direct:123"), accountId: "bot-1" };
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

  async function complete(
    requesterOrigin: DeliveryContext,
    childSessionKey = defaultChildSessionKey,
  ) {
    return await resolveSubagentCompletionOrigin({
      childSessionKey,
      requesterSessionKey,
      requesterOrigin,
      spawnMode: childSessionKey === telegramChildKey ? "run" : "session",
      expectsCompletionMessage: true,
    });
  }

  it.each(["slack", "folded-chat"])(
    "preserves a thread for case-folded %s targets",
    async (channel) => {
      registerTestSessionBindings(channel, "acct-1", [makeBinding(channel, "C123")]);
      const requester = { ...destination(channel, "channel:c123", "reply-1"), accountId: "acct-1" };
      expect(await complete(requester)).toEqual({
        ...requester,
        to: channel === "slack" ? "channel:c123" : "channel:C123",
      });
    },
  );

  it("retargets distinct case-sensitive conversations", async () => {
    registerTestSessionBindings("matrix", "acct-1", [makeBinding("matrix", "!room:server")]);
    expect(
      await complete({ ...destination("matrix", "channel:!Room:server"), accountId: "acct-1" }),
    ).toEqual({ ...destination("matrix", "room:!room:server"), accountId: "acct-1" });
  });

  it.each([
    ["bound-room", undefined, "bound-room", undefined],
    ["requester-room", undefined, "requester-room", "requester-thread"],
    ["requester-thread", undefined, "requester-room", "requester-thread"],
    ["bound-thread", "bound-room", "bound-thread", "bound-thread"],
  ] as const)("routes Discord binding %s under %s", async (id, parent, to, thread) => {
    registerTestSessionBindings("discord", "acct-1", [makeBinding("discord", id, parent)]);
    expect(await complete(discordRequester)).toEqual({
      ...destination("discord", `channel:${to}`, thread),
      accountId: "acct-1",
    });
  });

  it.each([false, true])(
    "prefers requester binding when present=%s, otherwise the child",
    async (hasRequester) => {
      const bindings = [makeBinding("telegram", "direct:123", undefined, true)];
      if (hasRequester) {
        bindings.push(makeBinding("telegram", "direct:789"));
      }
      registerTestSessionBindings("telegram", "bot-1", bindings);
      const requester = {
        ...telegramRequester,
        to: hasRequester ? "telegram:direct:789" : telegramRequester.to,
      };
      expect(await complete(requester, telegramChildKey)).toEqual(requester);
    },
  );
});

describe("completion delivery route fallback", () => {
  type MediaRoute = ReturnType<typeof resolveGeneratedMediaSessionDeliveryRoute>["route"];
  const routeCase = (
    name: string,
    base: DeliveryContext,
    override: Partial<CompletionOrigins>,
    expected: DeliveryContext,
    route?: MediaRoute,
  ) => ({
    name,
    origins: { directOrigin: base, requesterSessionOrigin: base, ...override },
    expected,
    route: route ?? { ...expected, chatType: "direct" },
  });

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
  const foldedOrigin = destination("folded-chat", "channel:c123", "reply-1");
  const scopedOrigin = destination("scoped-chat", "room:topic:root:sender:a", "reply-a");
  const opaqueOrigin = destination("matrix", "room:!example:topic:100", "$reply");
  const topicOrigin = {
    channel: "telegram",
    accountId: "bot-1",
    to: "telegram:123:topic:99",
    threadId: 99,
  };
  const retargetedTopic = { channel: "telegram", accountId: "bot-1", to: "telegram:123:topic:100" };

  it.each([
    ...["completionDirectOrigin", "directOrigin"].map((field) => {
      const expected = { ...foldedOrigin, to: "channel:C123" };
      return routeCase(
        `a case-folded ${field} target`,
        foldedOrigin,
        { [field]: { channel: "folded-chat", to: "channel:C123" } },
        expected,
        { ...expected, chatType: "channel" },
      );
    }),
    routeCase(
      "a to-only override to another topic",
      topicOrigin,
      { completionDirectOrigin: { to: retargetedTopic.to } },
      retargetedTopic,
    ),
    routeCase(
      "a direct origin retargeted to another topic",
      topicOrigin,
      { directOrigin: retargetedTopic },
      retargetedTopic,
    ),
    routeCase(
      "an explicit primary thread on a topic-qualified target",
      topicOrigin,
      { completionDirectOrigin: { ...retargetedTopic, threadId: 100 } },
      { ...retargetedTopic, threadId: 100 },
      { ...retargetedTopic, threadId: "100", chatType: "direct" },
    ),
    routeCase(
      "an unqualified target in the same topic's room",
      topicOrigin,
      { completionDirectOrigin: { to: "telegram:123" } },
      { ...topicOrigin, to: "telegram:123" },
      { ...topicOrigin, to: "telegram:123", threadId: "99", chatType: "direct" },
    ),
    ...["same", "different-port"].map((identity) => {
      const to = identity === "same" ? opaqueOrigin.to : "room:!example:topic:101";
      return routeCase(
        `an opaque Matrix room with ${identity} identity`,
        opaqueOrigin,
        { completionDirectOrigin: { to } },
        identity === "same" ? opaqueOrigin : { channel: "matrix", to },
      );
    }),
    ...[false, true].map((retargeted) => {
      const to = retargeted ? "alias-b" : "alias-a";
      return routeCase(
        retargeted ? "a different scoped identity with the same parent" : "a scoped alias",
        scopedOrigin,
        { completionDirectOrigin: { to } },
        retargeted ? { channel: "scoped-chat", to } : { ...scopedOrigin, to },
      );
    }),
    routeCase(
      "a case-distinct canonical identity on a channel with folded target ids",
      destination("scoped-chat", "alias-a", "reply-a"),
      { completionDirectOrigin: { channel: "scoped-chat", to: "alias-upper" } },
      { channel: "scoped-chat", to: "alias-upper" },
    ),
    ...[{ channel: "slack" }, { to: requesterSessionOrigin.to }].map((completionDirectOrigin) =>
      routeCase(
        `a partial completion origin ${JSON.stringify(completionDirectOrigin)}`,
        requesterSessionOrigin,
        { completionDirectOrigin },
        requesterSessionOrigin,
        { ...requesterSessionOrigin, chatType: "channel" },
      ),
    ),
  ])("uses $name for completion and generated-media delivery", ({ origins, expected, route }) => {
    expectDelivery({ ...origins, expectsCompletionMessage: true }, expected, route);
  });
});
