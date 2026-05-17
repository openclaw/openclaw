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

describe("agent-to-agent context identity", () => {
  const cfg = {
    agents: {
      list: [
        { id: "habit", identity: { name: "Stevo" } },
        { id: "story", identity: { name: "Story Bot" } },
      ],
    },
  } as never;

  it("includes configured requester identity name in the initial message context", () => {
    const context = buildAgentToAgentMessageContext({
      cfg,
      requesterSessionKey: "agent:habit:telegram:direct:6344794319",
      requesterChannel: "telegram",
      targetSessionKey: "agent:story:main",
    });

    expect(context).toContain("Agent 1 (requester) name: Stevo.");
    expect(context.indexOf("Agent 1 (requester) name: Stevo.")).toBeLessThan(
      context.indexOf("Agent 1 (requester) session:"),
    );
  });

  it("includes configured requester and target identity names in reply and announce contexts", () => {
    const shared = {
      cfg,
      requesterSessionKey: "agent:habit:telegram:direct:6344794319",
      requesterChannel: "telegram",
      targetSessionKey: "agent:story:main",
      targetChannel: "internal",
    };

    const replyContext = buildAgentToAgentReplyContext({
      ...shared,
      currentRole: "target",
      turn: 1,
      maxTurns: 2,
    });
    expect(replyContext).toContain("Agent 1 (requester) name: Stevo.");
    expect(replyContext).toContain("Agent 2 (target) name: Story Bot.");

    const announceContext = buildAgentToAgentAnnounceContext({
      ...shared,
      originalMessage: "check the metrics",
      roundOneReply: "done",
      latestReply: "done",
    });
    expect(announceContext).toContain("Agent 1 (requester) name: Stevo.");
    expect(announceContext).toContain("Agent 2 (target) name: Story Bot.");
  });
});

describe("resolvePingPongTurns", () => {
  it("defaults to 5 when unset", () => {
    expect(resolvePingPongTurns(undefined)).toBe(5);
    expect(resolvePingPongTurns({ session: {} } as never)).toBe(5);
  });

  it("uses configured values through the 20-turn ceiling", () => {
    expect(
      resolvePingPongTurns({ session: { agentToAgent: { maxPingPongTurns: 10 } } } as never),
    ).toBe(10);
    expect(
      resolvePingPongTurns({ session: { agentToAgent: { maxPingPongTurns: 20 } } } as never),
    ).toBe(20);
  });

  it("keeps defensive floor and ceiling clamps", () => {
    expect(
      resolvePingPongTurns({ session: { agentToAgent: { maxPingPongTurns: -1 } } } as never),
    ).toBe(0);
    expect(
      resolvePingPongTurns({ session: { agentToAgent: { maxPingPongTurns: 50 } } } as never),
    ).toBe(20);
  });
});
