// sessions_send helper tests cover session-key target parsing and ping-pong
// turn limits for agent-to-agent announce flows.
import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { resolveAnnounceTargetFromKey, resolvePingPongTurns } from "./sessions-send-helpers.js";

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

  it("supports direct session keys for feishu announce targets", () => {
    expect(resolveAnnounceTargetFromKey("agent:main:feishu:direct:ou_direct_user")).toEqual({
      channel: "feishu",
      to: "user:ou_direct_user",
      threadId: undefined,
    });
  });

  it("supports dm alias in direct announce target parsing", () => {
    expect(resolveAnnounceTargetFromKey("agent:main:feishu:dm:ou_direct_user")).toEqual({
      channel: "feishu",
      to: "user:ou_direct_user",
      threadId: undefined,
    });
  });

  it("supports account-scoped direct session keys", () => {
    expect(
      resolveAnnounceTargetFromKey("agent:main:feishu:acct_main:direct:ou_direct_user"),
    ).toEqual({
      channel: "feishu",
      to: "user:ou_direct_user",
      accountId: "acct_main",
      threadId: undefined,
    });
    expect(resolveAnnounceTargetFromKey("agent:main:feishu:acct_main:dm:ou_direct_user")).toEqual({
      channel: "feishu",
      to: "user:ou_direct_user",
      accountId: "acct_main",
      threadId: undefined,
    });
  });

  it("does not crash when resolveDeliveryTarget returns null", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "feishu",
          source: "test",
          plugin: {
            id: "feishu",
            meta: {
              id: "feishu",
              label: "Feishu",
              selectionLabel: "Feishu",
              docsPath: "/channels/feishu",
              blurb: "Feishu test stub.",
            },
            capabilities: { chatTypes: ["direct", "group", "thread"] },
            messaging: {
              resolveDeliveryTarget: () => null,
              normalizeTarget: (raw: string) => raw.replace(/^user:/, ""),
            },
            config: {
              listAccountIds: () => ["default"],
              resolveAccount: () => ({}),
            },
          },
        },
      ]),
    );

    expect(resolveAnnounceTargetFromKey("agent:main:feishu:direct:ou_direct_user")).toEqual({
      channel: "feishu",
      to: "ou_direct_user",
      threadId: undefined,
    });
    expect(
      resolveAnnounceTargetFromKey("agent:main:feishu:acct_main:direct:ou_direct_user"),
    ).toEqual({
      channel: "feishu",
      to: "ou_direct_user",
      accountId: "acct_main",
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
