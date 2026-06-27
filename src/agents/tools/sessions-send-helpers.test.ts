// sessions_send helper tests cover session-key target parsing and ping-pong
// turn limits for agent-to-agent announce flows.
import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import {
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

describe("agent-to-agent prompt context", () => {
  it("includes the concrete requester session as the return path", () => {
    const context = buildAgentToAgentMessageContext({
      requesterSessionKey: "agent:main:slack:channel:C123:thread:171.222",
      requesterChannel: "slack",
      targetSessionKey: "agent:worker:discord:channel:ops:run:run-123",
    });

    expect(context).toContain(
      "Agent 1 (requester) session: agent:main:slack:channel:C123:thread:171.222.",
    );
    expect(context).toContain(
      'Return replies with sessions_send(sessionKey: "agent:main:slack:channel:C123:thread:171.222", message: ...).',
    );
    expect(context).toContain("Agent 1 (requester) channel: slack.");
    expect(context).toContain("Agent 2 (target) session: <TARGET_SESSION>.");
    expect(context).not.toContain("agent:worker:discord:channel:ops:run:run-123");
  });

  it("keeps WhatsApp group requester keys concrete for return routing", () => {
    const context = buildAgentToAgentMessageContext({
      requesterSessionKey: "agent:koro:whatsapp:group:120363426513385961@g.us",
      requesterChannel: "whatsapp",
      targetSessionKey: "agent:alfred:main",
    });

    expect(context).toContain(
      "Agent 1 (requester) session: agent:koro:whatsapp:group:120363426513385961@g.us.",
    );
    expect(context).toContain(
      'Return replies with sessions_send(sessionKey: "agent:koro:whatsapp:group:120363426513385961@g.us", message: ...).',
    );
    expect(context).toContain("Agent 1 (requester) channel: whatsapp.");
  });

  it("preserves optional session line shape with concrete channel values", () => {
    const context = buildAgentToAgentReplyContext({
      requesterSessionKey: "agent:requester:main",
      targetSessionKey: "agent:target:main",
      targetChannel: "telegram",
      currentRole: "target",
      turn: 2,
      maxTurns: 5,
    });

    expect(context).toContain("Current agent: Agent 2 (target).");
    expect(context).toContain("Agent 1 (requester) session: agent:requester:main.");
    expect(context).not.toContain("Return replies with sessions_send");
    expect(context).not.toContain("Agent 1 (requester) channel:");
    expect(context).toContain("Agent 2 (target) session: <TARGET_SESSION>.");
    expect(context).toContain("Agent 2 (target) channel: telegram.");
    expect(context).not.toContain("agent:target:main");
  });

  it("does not tell requester-side ping-pong turns to send to themselves", () => {
    const context = buildAgentToAgentReplyContext({
      requesterSessionKey: "agent:koro:whatsapp:group:120363426513385961@g.us",
      requesterChannel: "whatsapp",
      targetSessionKey: "agent:alfred:main",
      currentRole: "requester",
      turn: 2,
      maxTurns: 5,
    });

    expect(context).toContain("Current agent: Agent 1 (requester).");
    expect(context).toContain(
      "Agent 1 (requester) session: agent:koro:whatsapp:group:120363426513385961@g.us.",
    );
    expect(context).not.toContain("Return replies with sessions_send");
  });
});
