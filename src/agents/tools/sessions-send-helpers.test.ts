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
  resolveSessionsSendTargetContext,
  resolveSessionsSendTimeouts,
} from "./sessions-send-helpers.js";

describe("sessions_send target context", () => {
  const base = {
    requesterSessionKey: "agent:main:main",
    resolvedKey: "main",
    displayKey: "agent:main:main",
    unresolvedDisplayKey: "main",
    mainKey: "main",
  };

  it("rejects a synchronous alias resolving to the requester session", () => {
    const result = resolveSessionsSendTargetContext({ ...base, timeoutSeconds: 30 });

    expect(result.requesterSessionKey).toBe("agent:main:main");
    expect(result.sameSessionA2A).toBe(true);
    expect(result.errorResult).toMatchObject({
      status: "error",
      sessionKey: "agent:main:main",
      error: expect.stringContaining("cannot synchronously target the current session"),
    });
  });

  it("preserves fire-and-forget delivery to the requester session", () => {
    expect(resolveSessionsSendTargetContext({ ...base, timeoutSeconds: 0 })).toEqual({
      requesterSessionKey: "agent:main:main",
      sameSessionA2A: true,
    });
  });

  it("rejects thread targets before dispatch", () => {
    const result = resolveSessionsSendTargetContext({
      ...base,
      resolvedKey: "agent:main:slack:channel:C123:thread:1710000000.000100",
      displayKey: "agent:main:slack:channel:C123:thread:1710000000.000100",
      unresolvedDisplayKey: "topic-session",
      timeoutSeconds: 0,
    });

    expect(result.errorResult).toMatchObject({
      status: "error",
      sessionKey: "topic-session",
      error: expect.stringContaining("cannot target a thread session"),
    });
  });

  it("resolves run and announcement timeout budgets", () => {
    expect(resolveSessionsSendTimeouts(5)).toEqual({
      timeoutMs: 5_000,
      announceTimeoutMs: 5_000,
    });
    expect(resolveSessionsSendTimeouts(0)).toEqual({
      timeoutMs: 0,
      announceTimeoutMs: 30_000,
    });
  });
});

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
  it("keeps volatile routing identifiers out of system prompt context", () => {
    const context = buildAgentToAgentMessageContext({
      requesterSessionKey: "agent:main:slack:channel:C123:thread:171.222",
      requesterChannel: "slack",
      targetSessionKey: "agent:worker:discord:channel:ops:run:run-123",
    });

    expect(context).toContain("Agent 1 (requester) session: <REQUESTER_SESSION>.");
    expect(context).toContain("Agent 1 (requester) channel: slack.");
    expect(context).toContain("Agent 2 (target) session: <TARGET_SESSION>.");
    expect(context).not.toContain("agent:main:slack:channel:C123:thread:171.222");
    expect(context).not.toContain("agent:worker:discord:channel:ops:run:run-123");
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
    expect(context).toContain("Agent 1 (requester) session: <REQUESTER_SESSION>.");
    expect(context).not.toContain("Agent 1 (requester) channel:");
    expect(context).toContain("Agent 2 (target) session: <TARGET_SESSION>.");
    expect(context).toContain("Agent 2 (target) channel: telegram.");
    expect(context).not.toContain("agent:requester:main");
    expect(context).not.toContain("agent:target:main");
  });
});
