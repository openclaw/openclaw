// Session conversation tests cover channel plugin conversation binding and session lookup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import {
  resolveSessionConversationRef,
  resolveSessionParentSessionKey,
  resolveSessionThreadInfo,
} from "./session-conversation.js";

describe("session conversation routing", () => {
  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
  });

  it("keeps generic :thread: parsing in core", () => {
    expect(
      resolveSessionConversationRef("agent:main:slack:channel:general:thread:1699999999.0001"),
    ).toEqual({
      channel: "slack",
      kind: "channel",
      rawId: "general:thread:1699999999.0001",
      id: "general",
      threadId: "1699999999.0001",
      baseSessionKey: "agent:main:slack:channel:general",
      baseConversationId: "general",
      parentConversationCandidates: ["general"],
    });
  });

  it("lets Telegram own :topic: session grammar", () => {
    expect(resolveSessionConversationRef("agent:main:telegram:group:-100123:topic:77")).toEqual({
      channel: "telegram",
      kind: "group",
      rawId: "-100123:topic:77",
      id: "-100123",
      threadId: "77",
      baseSessionKey: "agent:main:telegram:group:-100123",
      baseConversationId: "-100123",
      parentConversationCandidates: ["-100123"],
    });
    expect(resolveSessionThreadInfo("agent:main:telegram:group:-100123:topic:77")).toEqual({
      baseSessionKey: "agent:main:telegram:group:-100123",
      threadId: "77",
    });
    expect(resolveSessionParentSessionKey("agent:main:telegram:group:-100123:topic:77")).toBe(
      "agent:main:telegram:group:-100123",
    );
  });

  it("does not load bundled session-key fallbacks for inactive channel plugins", () => {
    resetPluginRuntimeStateForTest();
    setRuntimeConfigSnapshot({
      plugins: {
        entries: {
          telegram: {
            enabled: false,
          },
        },
      },
    });

    expect(resolveSessionConversationRef("agent:main:telegram:group:-100123:topic:77")).toEqual({
      channel: "telegram",
      kind: "group",
      rawId: "-100123:topic:77",
      id: "-100123:topic:77",
      threadId: undefined,
      baseSessionKey: "agent:main:telegram:group:-100123:topic:77",
      baseConversationId: "-100123:topic:77",
      parentConversationCandidates: [],
    });
  });

  it("lets Feishu own parent fallback candidates", () => {
    expect(
      resolveSessionConversationRef(
        "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      ),
    ).toEqual({
      channel: "feishu",
      kind: "group",
      rawId: "oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      id: "oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      threadId: undefined,
      baseSessionKey:
        "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      baseConversationId: "oc_group_chat",
      parentConversationCandidates: ["oc_group_chat:topic:om_topic_root", "oc_group_chat"],
    });
    expect(
      resolveSessionParentSessionKey(
        "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      ),
    ).toBeNull();
  });

  it.each([
    {
      name: "legacy-only parents",
      canonical: null,
      legacy: ["room"],
      parents: ["room"],
      base: "room",
      legacyCalls: 1,
    },
    {
      name: "explicit empty parents",
      canonical: {
        id: "room:sender:user",
        baseConversationId: "base",
        parentConversationCandidates: [],
      },
      legacy: ["legacy"],
      parents: [],
      base: "base",
      legacyCalls: 0,
    },
    {
      name: "explicit undefined parents",
      canonical: {
        id: "room:sender:user",
        baseConversationId: "base",
        parentConversationCandidates: undefined,
      },
      legacy: ["legacy"],
      parents: [],
      base: "base",
      legacyCalls: 0,
    },
    {
      name: "explicit ordered parents before legacy and base",
      canonical: {
        id: "room:sender:user",
        baseConversationId: "base",
        parentConversationCandidates: [" topic ", "room", "topic", " "],
      },
      legacy: ["legacy"],
      parents: ["topic", "room"],
      base: "room",
      legacyCalls: 0,
    },
    {
      name: "omitted parents use the legacy result",
      canonical: { id: "room:sender:user" },
      legacy: [" topic ", "room", "topic", " "],
      parents: ["topic", "room"],
      base: "room",
      legacyCalls: 1,
    },
    {
      name: "inherited parents survive a null legacy result",
      canonical: {
        id: "room:sender:user",
        __proto__: { parentConversationCandidates: ["topic", "room"] },
      },
      legacy: null,
      parents: ["topic", "room"],
      base: "room",
      legacyCalls: 1,
    },
    {
      name: "an empty legacy result keeps the inherited base",
      canonical: {
        id: "room:sender:user",
        __proto__: { parentConversationCandidates: ["topic", "room"] },
      },
      legacy: [],
      parents: [],
      base: "room",
      legacyCalls: 1,
    },
  ])(
    "keeps parent-candidate precedence for $name",
    ({ canonical, legacy, parents, base, legacyCalls }) => {
      const resolveParents = vi.fn(({ rawId }: { rawId: string }) =>
        rawId.endsWith(":sender:user") ? legacy : null,
      );
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "legacy-parent",
            source: "test",
            plugin: {
              ...createChannelTestPluginBase({
                id: "legacy-parent",
                capabilities: { chatTypes: ["group"] },
              }),
              messaging: {
                ...(canonical ? { resolveSessionConversation: () => canonical } : {}),
                resolveParentConversationCandidates: resolveParents,
              },
            },
          },
        ]),
      );

      const key = "agent:main:legacy-parent:group:room:sender:user";
      const expected = {
        channel: "legacy-parent",
        kind: "group",
        rawId: "room:sender:user",
        id: "room:sender:user",
        threadId: undefined,
        baseSessionKey: key,
        baseConversationId: base,
        parentConversationCandidates: parents,
      };
      const first = resolveSessionConversationRef(key);
      expect(first).toEqual(expected);
      expect(resolveParents).toHaveBeenCalledTimes(legacyCalls);
      first?.parentConversationCandidates.push("caller-only");
      expect(resolveSessionConversationRef(key)).toEqual(expected);
      expect(resolveParents).toHaveBeenCalledTimes(legacyCalls * 2);
    },
  );
});
