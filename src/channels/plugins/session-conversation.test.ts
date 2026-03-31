import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import {
  resolveParentConversationCandidates,
  resolveSessionConversationRef,
  resolveSessionParentSessionKey,
  resolveSessionThreadInfo,
} from "./session-conversation.js";

describe("session conversation routing", () => {
  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
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
      parentConversationCandidates: ["oc_group_chat:topic:om_topic_root", "oc_group_chat"],
    });
    expect(
      resolveParentConversationCandidates({
        channel: "feishu",
        kind: "group",
        rawId: "oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      }),
    ).toEqual(["oc_group_chat:topic:om_topic_root", "oc_group_chat"]);
    expect(
      resolveSessionParentSessionKey(
        "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      ),
    ).toBeNull();
  });
});
