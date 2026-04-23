import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getChannelPlugin: vi.fn(),
  resolveOutboundTarget: vi.fn(),
  deliverOutboundPayloads: vi.fn(),
  resolveRuntimePluginRegistry: vi.fn(),
  callGatewayLeastPrivilege: vi.fn(),
  randomIdempotencyKey: vi.fn(() => "idem-gateway"),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  normalizeChannelId: (channel?: string) => channel?.trim().toLowerCase() ?? undefined,
  getLoadedChannelPlugin: mocks.getChannelPlugin,
  getChannelPlugin: mocks.getChannelPlugin,
  listChannelPlugins: () => [],
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: () => "main",
  resolveSessionAgentId: ({
    sessionKey,
  }: {
    sessionKey?: string;
    config?: unknown;
    agentId?: string;
  }) => {
    const match = sessionKey?.match(/^agent:([^:]+)/i);
    return match?.[1] ?? "main";
  },
  resolveAgentWorkspaceDir: () => "/tmp/openclaw-test-workspace",
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: ({ config }: { config: unknown }) => ({ config, changes: [] }),
}));

vi.mock("../../plugins/loader.js", () => ({
  resolveRuntimePluginRegistry: mocks.resolveRuntimePluginRegistry,
}));

vi.mock("./targets.js", () => ({
  resolveOutboundTarget: mocks.resolveOutboundTarget,
}));

vi.mock("./deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
}));

vi.mock("./message.gateway.runtime.js", () => ({
  callGatewayLeastPrivilege: mocks.callGatewayLeastPrivilege,
  randomIdempotencyKey: mocks.randomIdempotencyKey,
}));

vi.mock("../../utils/message-channel.js", async () => {
  const actual = await vi.importActual<typeof import("../../utils/message-channel.js")>(
    "../../utils/message-channel.js",
  );
  const deliverable = ["forum", "directchat"];
  return {
    ...actual,
    listDeliverableMessageChannels: () => deliverable,
    isDeliverableMessageChannel: (channel: string) => deliverable.includes(channel),
    isGatewayMessageChannel: (channel: string) =>
      [...deliverable, actual.INTERNAL_MESSAGE_CHANNEL].includes(channel),
    normalizeMessageChannel: (value?: string | null) => value?.trim().toLowerCase() || undefined,
  };
});

import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";

let sendMessage: typeof import("./message.js").sendMessage;
let resetOutboundChannelResolutionStateForTest: typeof import("./channel-resolution.js").resetOutboundChannelResolutionStateForTest;

describe("sendMessage", () => {
  beforeAll(async () => {
    ({ sendMessage } = await import("./message.js"));
    ({ resetOutboundChannelResolutionStateForTest } = await import("./channel-resolution.js"));
  });

  beforeEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    resetOutboundChannelResolutionStateForTest();
    mocks.getChannelPlugin.mockClear();
    mocks.resolveOutboundTarget.mockClear();
    mocks.deliverOutboundPayloads.mockClear();
    mocks.resolveRuntimePluginRegistry.mockClear();
    mocks.callGatewayLeastPrivilege.mockClear();
    mocks.randomIdempotencyKey.mockClear();

    mocks.getChannelPlugin.mockReturnValue({
      outbound: { deliveryMode: "direct" },
    });
    mocks.resolveOutboundTarget.mockImplementation(({ to }: { to: string }) => ({ ok: true, to }));
    mocks.deliverOutboundPayloads.mockResolvedValue([{ channel: "forum", messageId: "m1" }]);
  });

  it("passes explicit agentId to outbound delivery for scoped media roots", async () => {
    await sendMessage({
      cfg: {},
      channel: "forum",
      to: "123456",
      content: "hi",
      agentId: "work",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({ agentId: "work" }),
        channel: "forum",
        to: "123456",
      }),
    );
  });

  it("forwards requesterSenderId into the outbound delivery session", async () => {
    await sendMessage({
      cfg: {},
      channel: "forum",
      to: "123456",
      content: "hi",
      requesterSenderId: "attacker",
      mirror: {
        sessionKey: "agent:main:forum:group:ops",
      },
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          key: "agent:main:forum:group:ops",
          requesterSenderId: "attacker",
        }),
      }),
    );
  });

  it("forwards non-id requester sender fields into the outbound delivery session", async () => {
    await sendMessage({
      cfg: {},
      channel: "forum",
      to: "123456",
      content: "hi",
      requesterSenderName: "Alice",
      requesterSenderUsername: "alice_u",
      requesterSenderE164: "+15551234567",
      mirror: {
        sessionKey: "agent:main:forum:group:ops",
      },
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          key: "agent:main:forum:group:ops",
          requesterSenderName: "Alice",
          requesterSenderUsername: "alice_u",
          requesterSenderE164: "+15551234567",
        }),
      }),
    );
  });

  it("uses requester session/account for outbound delivery policy context", async () => {
    await sendMessage({
      cfg: {},
      channel: "forum",
      to: "123456",
      content: "hi",
      requesterSessionKey: "agent:main:directchat:group:ops",
      requesterAccountId: "work",
      requesterSenderId: "attacker",
      mirror: {
        sessionKey: "agent:main:forum:dm:123456",
      },
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          key: "agent:main:directchat:group:ops",
          requesterAccountId: "work",
          requesterSenderId: "attacker",
        }),
        mirror: expect.objectContaining({
          sessionKey: "agent:main:forum:dm:123456",
        }),
      }),
    );
  });

  it("propagates the send idempotency key into mirrored transcript delivery", async () => {
    await sendMessage({
      cfg: {},
      channel: "forum",
      to: "123456",
      content: "hi",
      idempotencyKey: "idem-send-1",
      mirror: {
        sessionKey: "agent:main:forum:dm:123456",
      },
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        mirror: expect.objectContaining({
          sessionKey: "agent:main:forum:dm:123456",
          text: "hi",
          idempotencyKey: "idem-send-1",
        }),
      }),
    );
  });

  it("forwards Hermes arbiter metadata through gateway send mode", async () => {
    mocks.getChannelPlugin.mockReturnValue({
      outbound: { deliveryMode: "gateway" },
    });
    mocks.callGatewayLeastPrivilege.mockResolvedValue({ messageId: "gw-1" });

    await sendMessage({
      cfg: {},
      channel: "forum",
      to: "123456",
      content: "hi",
      hermesArbiter: {
        arbiter_topic: "dev-iox",
        arbiter_bot_name: "AHC_A8_bot",
        arbiter_trace_id: "openclaw:1745365200123:a1b2c",
        arbiter_action: {
          type: "message",
          payload: "hi",
        },
      },
    });

    expect(mocks.callGatewayLeastPrivilege).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "send",
        params: expect.objectContaining({
          metadata: expect.objectContaining({
            arbiter_topic: "dev-iox",
            arbiter_bot_name: "AHC_A8_bot",
            arbiter_trace_id: "openclaw:1745365200123:a1b2c",
            arbiter_action: expect.objectContaining({
              type: "message",
              payload: "hi",
            }),
          }),
        }),
      }),
    );
  });

  it("forwards Hermes arbiter metadata through direct delivery mode", async () => {
    await sendMessage({
      cfg: {},
      channel: "forum",
      to: "123456",
      content: "hi",
      hermesArbiter: {
        arbiter_topic: "dev-iox",
        arbiter_bot_name: "AHC_A8_bot",
        arbiter_trace_id: "openclaw:1745365200123:a1b2c",
        arbiter_action: {
          type: "status",
          payload: "hi",
        },
      },
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          arbiter_topic: "dev-iox",
          arbiter_bot_name: "AHC_A8_bot",
          arbiter_trace_id: "openclaw:1745365200123:a1b2c",
          arbiter_action: expect.objectContaining({
            type: "status",
            payload: "hi",
          }),
        }),
      }),
    );
  });

  it("applies mirror matrix semantics for MEDIA and silent token variants", async () => {
    const matrix: Array<{
      name: string;
      content: string;
      mediaUrl?: string;
      expectedPayloads: Array<{
        text: string;
        mediaUrl: string | null;
        mediaUrls: string[];
      }>;
      expectedMirror: {
        text: string;
        mediaUrls?: string[];
      };
    }> = [
      {
        name: "MEDIA directives",
        content: "Here\nMEDIA:https://example.com/a.png\nMEDIA:https://example.com/b.png",
        expectedPayloads: [
          {
            text: "Here",
            mediaUrl: null,
            mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
          },
        ],
        expectedMirror: {
          text: "Here",
          mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
        },
      },
      {
        name: "exact NO_REPLY",
        content: "NO_REPLY",
        expectedPayloads: [],
        expectedMirror: {
          text: "NO_REPLY",
          mediaUrls: undefined,
        },
      },
      {
        name: "JSON NO_REPLY",
        content: '{\n  "action": "NO_REPLY"\n}',
        expectedPayloads: [],
        expectedMirror: {
          text: '{\n  "action": "NO_REPLY"\n}',
          mediaUrls: undefined,
        },
      },
      {
        name: "exact NO_REPLY with explicit media",
        content: "NO_REPLY",
        mediaUrl: "https://example.com/c.png",
        expectedPayloads: [
          {
            text: "",
            mediaUrl: "https://example.com/c.png",
            mediaUrls: ["https://example.com/c.png"],
          },
        ],
        expectedMirror: {
          text: "NO_REPLY",
          mediaUrls: ["https://example.com/c.png"],
        },
      },
    ];

    for (const entry of matrix) {
      mocks.deliverOutboundPayloads.mockClear();

      await sendMessage({
        cfg: {},
        channel: "forum",
        to: "123456",
        content: entry.content,
        ...(entry.mediaUrl ? { mediaUrl: entry.mediaUrl } : {}),
        mirror: {
          sessionKey: "agent:main:forum:dm:123456",
        },
      });

      expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(1);
      const deliveryCall = mocks.deliverOutboundPayloads.mock.calls[0]?.[0] as
        | {
            payloads?: Array<{ text?: string; mediaUrl?: string; mediaUrls?: string[] }>;
            mirror?: unknown;
          }
        | undefined;
      const payloadSummary = (deliveryCall?.payloads ?? []).map((payload) => ({
        text: payload.text ?? "",
        mediaUrl: payload.mediaUrl ?? null,
        mediaUrls: payload.mediaUrls ?? [],
      }));
      expect(payloadSummary, entry.name).toEqual(entry.expectedPayloads);
      expect(deliveryCall?.mirror, entry.name).toEqual(
        expect.objectContaining({
          sessionKey: "agent:main:forum:dm:123456",
          text: entry.expectedMirror.text,
          mediaUrls: entry.expectedMirror.mediaUrls,
        }),
      );
    }
  });

  it("recovers plugin resolution after registry refresh", async () => {
    const forumPlugin = {
      outbound: { deliveryMode: "direct" },
    };
    mocks.getChannelPlugin
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(forumPlugin)
      .mockReturnValue(forumPlugin);

    await expect(
      sendMessage({
        cfg: { channels: { forum: { token: "test-token" } } },
        channel: "forum",
        to: "123456",
        content: "hi",
      }),
    ).resolves.toMatchObject({
      channel: "forum",
      to: "123456",
      via: "direct",
    });

    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledTimes(1);
  });
});
