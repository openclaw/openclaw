import { describe, expect, it, vi, beforeEach } from "vitest";
import type { MessengerHandlerContext } from "./bot-handlers.js";
import type { MessengerMessagingEvent } from "./types.js";

// Mock heavy dependencies so the handler module can be imported in isolation.
vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
  upsertChannelPairingRequest: vi.fn().mockResolvedValue({ code: "ABC", created: false }),
}));
vi.mock("../media/fetch.js", () => ({
  fetchRemoteMedia: vi.fn().mockResolvedValue({
    buffer: Buffer.from("fake"),
    contentType: "image/png",
  }),
}));
vi.mock("../media/store.js", () => ({
  MEDIA_MAX_BYTES: 5 * 1024 * 1024,
  saveMediaBuffer: vi.fn().mockResolvedValue({
    id: "uuid.png",
    path: "/tmp/media/inbound/uuid.png",
    size: 4,
    contentType: "image/png",
  }),
}));

const { handleMessengerWebhookEvents } = await import("./bot-handlers.js");

function makeContext(overrides?: Partial<MessengerHandlerContext>): MessengerHandlerContext {
  return {
    cfg: {},
    account: {
      accountId: "default",
      enabled: true,
      pageAccessToken: "tok",
      appSecret: "sec",
      verifyToken: "vtk",
      tokenSource: "config",
      config: { dmPolicy: "open", allowFrom: ["*"] },
    },
    runtime: {},
    processMessage: vi.fn(),
    ...overrides,
  } as unknown as MessengerHandlerContext;
}

describe("handleMessengerWebhookEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ignores echo events (is_echo: true)", async () => {
    const ctx = makeContext();
    const echoEvent: MessengerMessagingEvent = {
      sender: { id: "12345" },
      recipient: { id: "page-id" },
      timestamp: Date.now(),
      message: {
        mid: "mid.echo",
        text: "Hello from page",
        is_echo: true,
        app_id: 111,
      },
    };

    await handleMessengerWebhookEvents([echoEvent], ctx);

    expect(ctx.processMessage).not.toHaveBeenCalled();
  });

  it("ignores read receipt events", async () => {
    const ctx = makeContext();
    const readEvent: MessengerMessagingEvent = {
      sender: { id: "12345" },
      recipient: { id: "page-id" },
      timestamp: Date.now(),
      read: { watermark: 123456 },
    };

    await handleMessengerWebhookEvents([readEvent], ctx);

    expect(ctx.processMessage).not.toHaveBeenCalled();
  });

  it("ignores delivery receipt events", async () => {
    const ctx = makeContext();
    const deliveryEvent: MessengerMessagingEvent = {
      sender: { id: "12345" },
      recipient: { id: "page-id" },
      timestamp: Date.now(),
      delivery: { watermark: 123456 },
    };

    await handleMessengerWebhookEvents([deliveryEvent], ctx);

    expect(ctx.processMessage).not.toHaveBeenCalled();
  });
});
