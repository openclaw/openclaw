import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOutboundTarget } from "../../infra/outbound/targets.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { sendHandlers } from "./send.js";
import type { GatewayRequestContext } from "./types.js";

const mocks = vi.hoisted(() => ({
  deliverOutboundPayloads: vi.fn(),
  appendAssistantMessageToSessionTranscript: vi.fn(async () => ({ ok: true, sessionFile: "x" })),
  recordSessionMetaFromInbound: vi.fn(async () => ({ ok: true })),
  resolveOutboundTarget: vi.fn(() => ({ ok: true, to: "resolved" })),
  resolveMessageChannelSelection: vi.fn(),
  sendPoll: vi.fn(async () => ({ messageId: "poll-1" })),
  getChannelPlugin: vi.fn(),
  loadOpenClawPlugins: vi.fn(),
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    loadConfig: () => ({}),
  };
});

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: mocks.getChannelPlugin,
  normalizeChannelId: (value: string) => (value === "webchat" ? null : value),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveSessionAgentId: ({
    sessionKey,
  }: {
    sessionKey?: string;
    config?: unknown;
    agentId?: string;
  }) => {
    if (typeof sessionKey === "string") {
      const match = sessionKey.match(/^agent:([^:]+)/i);
      if (match?.[1]) {
        return match[1];
      }
    }
    return "main";
  },
  resolveDefaultAgentId: () => "main",
  resolveAgentWorkspaceDir: () => "/tmp/openclaw-test-workspace",
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: ({ config }: { config: unknown }) => ({ config, changes: [] }),
}));

vi.mock("../../plugins/loader.js", () => ({
  loadOpenClawPlugins: mocks.loadOpenClawPlugins,
}));

vi.mock("../../infra/outbound/targets.js", () => ({
  resolveOutboundTarget: mocks.resolveOutboundTarget,
}));

vi.mock("../../infra/outbound/channel-selection.js", () => ({
  resolveMessageChannelSelection: mocks.resolveMessageChannelSelection,
}));

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
}));

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    appendAssistantMessageToSessionTranscript: mocks.appendAssistantMessageToSessionTranscript,
    recordSessionMetaFromInbound: mocks.recordSessionMetaFromInbound,
  };
});

const makeContext = (): GatewayRequestContext =>
  ({
    dedupe: new Map(),
  }) as unknown as GatewayRequestContext;

async function runSend(params: Record<string, unknown>) {
  const respond = vi.fn();
  await sendHandlers.send({
    params: params as never,
    respond,
    context: makeContext(),
    req: { type: "req", id: "1", method: "send" },
    client: null,
    isWebchatConnect: () => false,
  });
  return { respond };
}

async function runPoll(params: Record<string, unknown>) {
  const respond = vi.fn();
  await sendHandlers.poll({
    params: params as never,
    respond,
    context: makeContext(),
    req: { type: "req", id: "1", method: "poll" },
    client: null,
    isWebchatConnect: () => false,
  });
  return { respond };
}

function mockDeliverySuccess(messageId: string) {
  mocks.deliverOutboundPayloads.mockResolvedValue([{ messageId, channel: "slack" }]);
}

describe("gateway send mirroring", () => {
  let registrySeq = 0;

  beforeEach(() => {
    vi.clearAllMocks();
    registrySeq += 1;
    setActivePluginRegistry(createTestRegistry([]), `send-test-${registrySeq}`);
    mocks.resolveOutboundTarget.mockReturnValue({ ok: true, to: "resolved" });
    mocks.resolveMessageChannelSelection.mockResolvedValue({
      channel: "slack",
      configured: ["slack"],
    });
    mocks.sendPoll.mockResolvedValue({ messageId: "poll-1" });
    mocks.getChannelPlugin.mockReturnValue({ outbound: { sendPoll: mocks.sendPoll } });
  });

  it("accepts media-only sends without message", async () => {
    mockDeliverySuccess("m-media");

    const { respond } = await runSend({
      to: "channel:C1",
      mediaUrl: "https://example.com/a.png",
      channel: "slack",
      idempotencyKey: "idem-media-only",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        payloads: [{ text: "", mediaUrl: "https://example.com/a.png", mediaUrls: undefined }],
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ messageId: "m-media" }),
      undefined,
      expect.objectContaining({ channel: "slack" }),
    );
  });

  it("rejects empty sends when neither text nor media is present", async () => {
    const { respond } = await runSend({
      to: "channel:C1",
      message: "   ",
      channel: "slack",
      idempotencyKey: "idem-empty",
    });

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("text or media is required"),
      }),
    );
  });

  it("returns actionable guidance when channel is internal webchat", async () => {
    const { respond } = await runSend({
      to: "x",
      message: "hi",
      channel: "webchat",
      idempotencyKey: "idem-webchat",
    });

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("unsupported channel: webchat"),
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("Use `chat.send`"),
      }),
    );
  });

  it("auto-picks the single configured channel for send", async () => {
    mockDeliverySuccess("m-single-send");

    const { respond } = await runSend({
      to: "x",
      message: "hi",
      idempotencyKey: "idem-missing-channel",
    });

    expect(mocks.resolveMessageChannelSelection).toHaveBeenCalled();
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ messageId: "m-single-send" }),
      undefined,
      expect.objectContaining({ channel: "slack" }),
    );
  });

  it("returns invalid request when send channel selection is ambiguous", async () => {
    mocks.resolveMessageChannelSelection.mockRejectedValueOnce(
      new Error("Channel is required when multiple channels are configured: telegram, slack"),
    );

    const { respond } = await runSend({
      to: "x",
      message: "hi",
      idempotencyKey: "idem-missing-channel-ambiguous",
    });

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("Channel is required"),
      }),
    );
  });

  it("auto-picks the single configured channel for poll", async () => {
    const { respond } = await runPoll({
      to: "x",
      question: "Q?",
      options: ["A", "B"],
      idempotencyKey: "idem-poll-missing-channel",
    });

    expect(mocks.resolveMessageChannelSelection).toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined, {
      channel: "slack",
    });
  });

  it("returns invalid request when poll channel selection is ambiguous", async () => {
    mocks.resolveMessageChannelSelection.mockRejectedValueOnce(
      new Error("Channel is required when multiple channels are configured: telegram, slack"),
    );

    const { respond } = await runPoll({
      to: "x",
      question: "Q?",
      options: ["A", "B"],
      idempotencyKey: "idem-poll-missing-channel-ambiguous",
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("Channel is required"),
      }),
    );
  });

  it("does not mirror when delivery returns no results", async () => {
    mocks.deliverOutboundPayloads.mockResolvedValue([]);

    await runSend({
      to: "channel:C1",
      message: "hi",
      channel: "slack",
      idempotencyKey: "idem-1",
      sessionKey: "agent:main:main",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        mirror: expect.objectContaining({
          sessionKey: "agent:main:main",
        }),
      }),
    );
  });

  it("mirrors media filenames when delivery succeeds", async () => {
    mockDeliverySuccess("m1");

    await runSend({
      to: "channel:C1",
      message: "caption",
      mediaUrl: "https://example.com/files/report.pdf?sig=1",
      channel: "slack",
      idempotencyKey: "idem-2",
      sessionKey: "agent:main:main",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        mirror: expect.objectContaining({
          sessionKey: "agent:main:main",
          text: "caption",
          mediaUrls: ["https://example.com/files/report.pdf?sig=1"],
        }),
      }),
    );
  });

  it("mirrors MEDIA tags as attachments", async () => {
    mockDeliverySuccess("m2");

    await runSend({
      to: "channel:C1",
      message: "Here\nMEDIA:https://example.com/image.png",
      channel: "slack",
      idempotencyKey: "idem-3",
      sessionKey: "agent:main:main",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        mirror: expect.objectContaining({
          sessionKey: "agent:main:main",
          text: "Here",
          mediaUrls: ["https://example.com/image.png"],
        }),
      }),
    );
  });

  it("lowercases provided session keys for mirroring", async () => {
    mockDeliverySuccess("m-lower");

    await runSend({
      to: "channel:C1",
      message: "hi",
      channel: "slack",
      idempotencyKey: "idem-lower",
      sessionKey: "agent:main:slack:channel:C123",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        mirror: expect.objectContaining({
          sessionKey: "agent:main:slack:channel:c123",
        }),
      }),
    );
  });

  it("derives a target session key when none is provided", async () => {
    mockDeliverySuccess("m3");

    await runSend({
      to: "channel:C1",
      message: "hello",
      channel: "slack",
      idempotencyKey: "idem-4",
    });

    expect(mocks.recordSessionMetaFromInbound).toHaveBeenCalled();
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        mirror: expect.objectContaining({
          sessionKey: "agent:main:slack:channel:resolved",
          agentId: "main",
        }),
      }),
    );
  });

  it("uses explicit agentId for delivery when sessionKey is not provided", async () => {
    mockDeliverySuccess("m-agent");

    await runSend({
      to: "channel:C1",
      message: "hello",
      channel: "slack",
      agentId: "work",
      idempotencyKey: "idem-agent-explicit",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          agentId: "work",
          key: "agent:work:slack:channel:resolved",
        }),
        mirror: expect.objectContaining({
          sessionKey: "agent:work:slack:channel:resolved",
          agentId: "work",
        }),
      }),
    );
  });

  it("uses sessionKey agentId when explicit agentId is omitted", async () => {
    mockDeliverySuccess("m-session-agent");

    await runSend({
      to: "channel:C1",
      message: "hello",
      channel: "slack",
      sessionKey: "agent:work:slack:channel:c1",
      idempotencyKey: "idem-session-agent",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          agentId: "work",
          key: "agent:work:slack:channel:c1",
        }),
        mirror: expect.objectContaining({
          sessionKey: "agent:work:slack:channel:c1",
          agentId: "work",
        }),
      }),
    );
  });

  it("prefers explicit agentId over sessionKey agent for delivery and mirror", async () => {
    mockDeliverySuccess("m-agent-precedence");

    await runSend({
      to: "channel:C1",
      message: "hello",
      channel: "slack",
      agentId: "work",
      sessionKey: "agent:main:slack:channel:c1",
      idempotencyKey: "idem-agent-precedence",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          agentId: "work",
          key: "agent:main:slack:channel:c1",
        }),
        mirror: expect.objectContaining({
          sessionKey: "agent:main:slack:channel:c1",
          agentId: "work",
        }),
      }),
    );
  });

  it("ignores blank explicit agentId and falls back to sessionKey agent", async () => {
    mockDeliverySuccess("m-agent-blank");

    await runSend({
      to: "channel:C1",
      message: "hello",
      channel: "slack",
      agentId: "   ",
      sessionKey: "agent:work:slack:channel:c1",
      idempotencyKey: "idem-agent-blank",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          agentId: "work",
          key: "agent:work:slack:channel:c1",
        }),
        mirror: expect.objectContaining({
          sessionKey: "agent:work:slack:channel:c1",
          agentId: "work",
        }),
      }),
    );
  });

  it("forwards threadId to outbound delivery when provided", async () => {
    mockDeliverySuccess("m-thread");

    await runSend({
      to: "channel:C1",
      message: "hi",
      channel: "slack",
      threadId: "1710000000.9999",
      idempotencyKey: "idem-thread",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "1710000000.9999",
      }),
    );
  });

  it("returns invalid request when outbound target resolution fails", async () => {
    vi.mocked(resolveOutboundTarget).mockReturnValue({
      ok: false,
      error: new Error("target not found"),
    });

    const { respond } = await runSend({
      to: "channel:C1",
      message: "hi",
      channel: "slack",
      idempotencyKey: "idem-target-fail",
    });

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("target not found"),
      }),
      expect.objectContaining({
        channel: "slack",
      }),
    );
  });

  it("recovers cold plugin resolution for telegram threaded sends", async () => {
    mocks.resolveOutboundTarget.mockReturnValue({ ok: true, to: "123" });
    mocks.deliverOutboundPayloads.mockResolvedValue([
      { messageId: "m-telegram", channel: "telegram" },
    ]);
    const telegramPlugin = { outbound: { sendPoll: mocks.sendPoll } };
    mocks.getChannelPlugin
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(telegramPlugin)
      .mockReturnValue(telegramPlugin);

    const { respond } = await runSend({
      to: "123",
      message: "forum completion",
      channel: "telegram",
      threadId: "42",
      idempotencyKey: "idem-cold-telegram-thread",
    });

    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(1);
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "123",
        threadId: "42",
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ messageId: "m-telegram" }),
      undefined,
      expect.objectContaining({ channel: "telegram" }),
    );
  });
});
