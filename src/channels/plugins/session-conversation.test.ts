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
import type { ChannelMessagingAdapter } from "./types.core.js";

type HookResult = ReturnType<NonNullable<ChannelMessagingAdapter["resolveSessionConversation"]>>;
const canonical = { id: "room:sender:user", baseConversationId: "base" };
const orderedParents = ["topic", "room"];
const untrimmedParents = [" topic ", "room", "topic", " "];
const inherited = {
  id: "room:sender:user",
  __proto__: { parentConversationCandidates: ["topic", "room"] },
};
const telegramTopicKey = "agent:main:telegram:group:-100123:topic:77";

function conversation(channel: string, kind: "group" | "channel", rawId: string, id = rawId) {
  return {
    channel,
    kind,
    rawId,
    id,
    threadId: undefined,
    baseSessionKey: `agent:main:${channel}:${kind}:${id}`,
    baseConversationId: id,
    parentConversationCandidates: [],
  };
}

describe("session conversation routing", () => {
  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
  });

  afterEach(clearRuntimeConfigSnapshot);

  it("lets Telegram own :topic: session grammar", () => {
    expect(resolveSessionConversationRef(telegramTopicKey)).toEqual({
      ...conversation("telegram", "group", "-100123:topic:77", "-100123"),
      threadId: "77",
      parentConversationCandidates: ["-100123"],
    });
    expect(resolveSessionThreadInfo(telegramTopicKey)).toEqual({
      baseSessionKey: "agent:main:telegram:group:-100123",
      threadId: "77",
    });
    expect(resolveSessionParentSessionKey(telegramTopicKey)).toBe(
      "agent:main:telegram:group:-100123",
    );
  });

  it("does not load bundled session-key fallbacks for inactive channel plugins", () => {
    resetPluginRuntimeStateForTest();
    setRuntimeConfigSnapshot({ plugins: { entries: { telegram: { enabled: false } } } });

    expect(resolveSessionConversationRef(telegramTopicKey)).toEqual(
      conversation("telegram", "group", "-100123:topic:77"),
    );
  });

  it("lets Feishu own parent fallback candidates", () => {
    const rawId = "oc_group_chat:topic:om_topic_root:sender:ou_topic_user";
    const key = `agent:main:feishu:group:${rawId}`;
    expect(resolveSessionConversationRef(key)).toEqual({
      ...conversation("feishu", "group", rawId),
      baseConversationId: "oc_group_chat",
      parentConversationCandidates: ["oc_group_chat:topic:om_topic_root", "oc_group_chat"],
    });
    expect(resolveSessionParentSessionKey(key)).toBeNull();
  });

  it.each([
    ["legacy-only parents", null, ["room"], ["room"], "room", 1],
    [
      "explicit empty parents",
      { ...canonical, parentConversationCandidates: [] },
      ["legacy"],
      [],
      "base",
      0,
    ],
    [
      "explicit undefined parents",
      { ...canonical, parentConversationCandidates: undefined },
      ["legacy"],
      [],
      "base",
      0,
    ],
    [
      "explicit ordered parents before legacy and base",
      { ...canonical, parentConversationCandidates: untrimmedParents },
      ["legacy"],
      orderedParents,
      "room",
      0,
    ],
    [
      "omitted parents use the legacy result",
      { id: canonical.id },
      untrimmedParents,
      orderedParents,
      "room",
      1,
    ],
    ["inherited parents survive a null legacy result", inherited, null, orderedParents, "room", 1],
    ["an empty legacy result keeps the inherited base", inherited, [], [], "room", 1],
  ] satisfies [string, HookResult, string[] | null, string[], string, number][])(
    "keeps parent-candidate precedence for %s",
    (_name, resolved, legacy, parents, base, legacyCalls) => {
      const resolveParents = vi.fn(({ rawId }: { rawId: string }) =>
        rawId.endsWith(":sender:user") ? legacy : null,
      );
      const plugin = {
        ...createChannelTestPluginBase({
          id: "legacy-parent",
          capabilities: { chatTypes: ["group"] },
        }),
        messaging: {
          ...(resolved ? { resolveSessionConversation: () => resolved } : {}),
          resolveParentConversationCandidates: resolveParents,
        },
      };
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: plugin.id, source: "test", plugin }]),
      );

      const key = "agent:main:legacy-parent:group:room:sender:user";
      const expected = {
        ...conversation("legacy-parent", "group", "room:sender:user"),
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
