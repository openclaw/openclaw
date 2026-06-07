// sessions_send helper tests cover session-key target parsing and ping-pong
// turn limits for agent-to-agent announce flows.
import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import {
  buildAgentToAgentAnnounceContext,
  buildAgentToAgentMessageContext,
  buildAgentToAgentReplyContext,
  resolveAnnounceTargetFromKey,
  resolvePingPongTurns,
} from "./sessions-send-helpers.js";

describe("resolveAnnounceTargetFromKey", () => {
  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
  });

  it("lets plugins own session-derived target shapes", () => {
    expect(resolveAnnounceTargetFromKey("agent:main:discord:group:dev")).toEqual({
      channel: "discord",
      to: "channel:dev",
      threadId: undefined,
    });
    expect(resolveAnnounceTargetFromKey("agent:main:slack:group:C123")).toEqual({
      channel: "slack",
      to: "channel:C123",
      threadId: undefined,
    });
  });

  it("keeps generic topic extraction and plugin normalization for other channels", () => {
    expect(resolveAnnounceTargetFromKey("agent:main:telegram:group:-100123:topic:99")).toEqual({
      channel: "telegram",
      to: "-100123",
      threadId: "99",
    });
  });

  it("preserves decimal thread ids for Slack-style session keys", () => {
    expect(
      resolveAnnounceTargetFromKey("agent:main:slack:channel:general:thread:1699999999.0001"),
    ).toEqual({
      channel: "slack",
      to: "channel:general",
      threadId: "1699999999.0001",
    });
  });

  it("preserves colon-delimited matrix ids for channel and thread targets", () => {
    // Matrix room/thread ids can contain colons, so parsing must split only on
    // known wrappers instead of generic colon segments.
    expect(
      resolveAnnounceTargetFromKey(
        "agent:main:matrix:channel:!room:example.org:thread:$AbC123:example.org",
      ),
    ).toEqual({
      channel: "matrix",
      to: "channel:!room:example.org",
      threadId: "$AbC123:example.org",
    });
  });

  it("preserves feishu conversation ids that embed :topic: in the base id", () => {
    expect(
      resolveAnnounceTargetFromKey(
        "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      ),
    ).toEqual({
      channel: "feishu",
      to: "oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      threadId: undefined,
    });
  });
});

describe("resolvePingPongTurns", () => {
  it("uses the fixed five-turn limit", () => {
    expect(resolvePingPongTurns()).toBe(5);
  });
});

describe("agent-to-agent prompt context", () => {
  it("keeps volatile routing identifiers out of system prompt context", () => {
    const context = buildAgentToAgentMessageContext({
      requesterName: "Stevo",
      requesterSessionKey: "agent:main:slack:channel:C123:thread:171.222",
      requesterChannel: "slack",
      targetSessionKey: "agent:worker:discord:channel:ops:run:run-123",
    });

    expect(context).toContain("Agent 1 (requester) name: Stevo.");
    expect(context).toContain("Agent 1 (requester) session: <REQUESTER_SESSION>.");
    expect(context).toContain("Agent 1 (requester) channel: slack.");
    expect(context).toContain("Agent 2 (target) session: <TARGET_SESSION>.");
    expect(context).not.toContain("agent:main:slack:channel:C123:thread:171.222");
    expect(context).not.toContain("agent:worker:discord:channel:ops:run:run-123");
  });

  it("preserves optional session line shape with concrete channel values", () => {
    const context = buildAgentToAgentReplyContext({
      requesterName: "Stevo",
      requesterSessionKey: "agent:requester:main",
      targetSessionKey: "agent:target:main",
      targetChannel: "telegram",
      currentRole: "target",
      turn: 2,
      maxTurns: 5,
    });

    expect(context).toContain("Current agent: Agent 2 (target).");
    expect(context).toContain("Agent 1 (requester) name: Stevo.");
    expect(context).toContain("Agent 1 (requester) session: <REQUESTER_SESSION>.");
    expect(context).not.toContain("Agent 1 (requester) channel:");
    expect(context).toContain("Agent 2 (target) session: <TARGET_SESSION>.");
    expect(context).toContain("Agent 2 (target) channel: telegram.");
    expect(context).not.toContain("agent:requester:main");
    expect(context).not.toContain("agent:target:main");
  });

  it("includes the requester identity name in ping-pong reply prompts", () => {
    const text = buildAgentToAgentReplyContext({
      requesterName: "Stevo",
      requesterSessionKey: "agent:habit:telegram:direct:123",
      requesterChannel: "telegram",
      targetSessionKey: "agent:story:main",
      targetChannel: "main",
      currentRole: "requester",
      turn: 1,
      maxTurns: 5,
    });

    expect(text).toContain("Agent 1 (requester) name: Stevo.");
    expect(text).toContain("Agent 1 (requester) session: <REQUESTER_SESSION>.");
    expect(text).toContain("Agent 2 (target) session: <TARGET_SESSION>.");
    expect(text).not.toContain("agent:habit:telegram:direct:123");
    expect(text).not.toContain("agent:story:main");
    expect(text).toContain("Turn 1 of 5.");
  });

  it("includes the requester identity name in the announce prompt", () => {
    const text = buildAgentToAgentAnnounceContext({
      requesterName: "Stevo",
      requesterSessionKey: "agent:habit:telegram:direct:123",
      requesterChannel: "telegram",
      targetSessionKey: "agent:story:main",
      targetChannel: "telegram",
      originalMessage: "Please summarize the latest status.",
      roundOneReply: "First pass reply.",
      latestReply: "Final answer.",
    });

    expect(text).toContain("Agent 1 (requester) name: Stevo.");
    expect(text).toContain("Agent 1 (requester) session: <REQUESTER_SESSION>.");
    expect(text).toContain("Agent 2 (target) session: <TARGET_SESSION>.");
    expect(text).not.toContain("agent:habit:telegram:direct:123");
    expect(text).not.toContain("agent:story:main");
    expect(text).toContain("Original request: Please summarize the latest status.");
  });
});
