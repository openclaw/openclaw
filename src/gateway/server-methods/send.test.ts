import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOutboundTarget } from "../../infra/outbound/targets.js";
import { sendHandlers } from "./send.js";
import type { GatewayRequestContext } from "./types.js";

const mocks = vi.hoisted(() => ({
  deliverOutboundPayloads: vi.fn(),
  appendAssistantMessageToSessionTranscript: vi.fn(async () => ({ ok: true, sessionFile: "x" })),
  recordSessionMetaFromInbound: vi.fn(async () => ({ ok: true })),
  resolveOutboundTarget: vi.fn(() => ({ ok: true, to: "resolved" })),
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
  getChannelPlugin: () => ({ outbound: {} }),
  normalizeChannelId: (value: string) => (value === "webchat" ? null : value),
}));

vi.mock("../../infra/outbound/targets.js", () => ({
  resolveOutboundTarget: mocks.resolveOutboundTarget,
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

function mockDeliverySuccess(messageId: string) {
  mocks.deliverOutboundPayloads.mockResolvedValue([{ messageId, channel: "slack" }]);
}

describe("gateway send mirroring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveOutboundTarget.mockReturnValue({ ok: true, to: "resolved" });
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
});
