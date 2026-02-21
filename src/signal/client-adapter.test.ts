import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  adapterRpcRequest,
  detectSignalApiMode,
  sendMessageAdapter,
  sendTypingAdapter,
  sendReceiptAdapter,
  fetchAttachmentAdapter,
  checkAdapter,
  streamSignalEventsAdapter,
} from "./client-adapter.js";

// Mock the native client
vi.mock("./client.js", () => ({
  signalCheck: vi.fn(),
  signalRpcRequest: vi.fn(),
  streamSignalEvents: vi.fn(),
}));

// Mock the container client
vi.mock("./client-container.js", () => ({
  containerCheck: vi.fn(),
  containerRestRequest: vi.fn(),
  containerSendMessage: vi.fn(),
  containerSendTyping: vi.fn(),
  containerSendReceipt: vi.fn(),
  containerSendReaction: vi.fn(),
  containerRemoveReaction: vi.fn(),
  containerFetchAttachment: vi.fn(),
  streamContainerEvents: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));
import { loadConfig } from "../config/config.js";
import {
  containerCheck,
  containerSendMessage,
  containerSendTyping,
  containerSendReceipt,
  containerSendReaction,
  containerRemoveReaction,
  containerFetchAttachment,
  streamContainerEvents,
} from "./client-container.js";
import { signalCheck, signalRpcRequest, streamSignalEvents } from "./client.js";

const mockSignalCheck = vi.mocked(signalCheck);
const mockSignalRpcRequest = vi.mocked(signalRpcRequest);
const mockStreamSignalEvents = vi.mocked(streamSignalEvents);
const mockContainerCheck = vi.mocked(containerCheck);
const mockContainerSendMessage = vi.mocked(containerSendMessage);
const mockContainerSendTyping = vi.mocked(containerSendTyping);
const mockContainerSendReceipt = vi.mocked(containerSendReceipt);
const mockContainerSendReaction = vi.mocked(containerSendReaction);
const mockContainerRemoveReaction = vi.mocked(containerRemoveReaction);
const mockContainerFetchAttachment = vi.mocked(containerFetchAttachment);
const mockStreamContainerEvents = vi.mocked(streamContainerEvents);
const mockLoadConfig = vi.mocked(loadConfig);

function setApiMode(mode: "native" | "container" | "auto") {
  mockLoadConfig.mockReturnValue({
    channels: {
      signal: {
        apiMode: mode,
      },
    },
  });
}

describe("detectSignalApiMode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setApiMode("native");
  });

  it("returns native when native endpoint responds", async () => {
    mockSignalCheck.mockResolvedValue({ ok: true, status: 200 });
    mockContainerCheck.mockResolvedValue({ ok: false, status: 404 });

    const result = await detectSignalApiMode("http://localhost:8080");
    expect(result).toBe("native");
  });

  it("returns container when only container endpoint responds", async () => {
    mockSignalCheck.mockResolvedValue({ ok: false, status: 404 });
    mockContainerCheck.mockResolvedValue({ ok: true, status: 200 });

    const result = await detectSignalApiMode("http://localhost:8080");
    expect(result).toBe("container");
  });

  it("prefers native when both endpoints respond", async () => {
    mockSignalCheck.mockResolvedValue({ ok: true, status: 200 });
    mockContainerCheck.mockResolvedValue({ ok: true, status: 200 });

    const result = await detectSignalApiMode("http://localhost:8080");
    expect(result).toBe("native");
  });

  it("throws error when neither endpoint responds", async () => {
    mockSignalCheck.mockResolvedValue({ ok: false, status: null, error: "Connection refused" });
    mockContainerCheck.mockResolvedValue({ ok: false, status: null, error: "Connection refused" });

    await expect(detectSignalApiMode("http://localhost:8080")).rejects.toThrow(
      "Signal API not reachable at http://localhost:8080",
    );
  });

  it("handles exceptions from check functions", async () => {
    mockSignalCheck.mockRejectedValue(new Error("Network error"));
    mockContainerCheck.mockRejectedValue(new Error("Network error"));

    await expect(detectSignalApiMode("http://localhost:8080")).rejects.toThrow(
      "Signal API not reachable",
    );
  });

  it("respects timeout parameter", async () => {
    mockSignalCheck.mockResolvedValue({ ok: true, status: 200 });
    mockContainerCheck.mockResolvedValue({ ok: false });

    await detectSignalApiMode("http://localhost:8080", 5000);
    expect(mockSignalCheck).toHaveBeenCalledWith("http://localhost:8080", 5000);
    expect(mockContainerCheck).toHaveBeenCalledWith("http://localhost:8080", 5000);
  });
});

describe("sendMessageAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setApiMode("native");
  });

  it("uses native JSON-RPC for native mode", async () => {
    mockSignalRpcRequest.mockResolvedValue({ timestamp: 1700000000000 });

    const result = await sendMessageAdapter({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipients: ["+15550001111"],
      message: "Hello world",
    });

    expect(result).toEqual({ timestamp: 1700000000000 });
    expect(mockSignalRpcRequest).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        message: "Hello world",
        account: "+14259798283",
        recipient: ["+15550001111"],
      }),
      expect.objectContaining({ baseUrl: "http://localhost:8080" }),
    );
    expect(mockContainerSendMessage).not.toHaveBeenCalled();
  });

  it("uses container REST for container mode", async () => {
    setApiMode("container");
    mockContainerSendMessage.mockResolvedValue({ timestamp: 1700000000000 });

    const result = await sendMessageAdapter({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipients: ["+15550001111"],
      message: "Hello world",
    });

    expect(result).toEqual({ timestamp: 1700000000000 });
    expect(mockContainerSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "http://localhost:8080",
        account: "+14259798283",
        recipients: ["+15550001111"],
        message: "Hello world",
      }),
    );
    expect(mockSignalRpcRequest).not.toHaveBeenCalled();
  });

  it("strips uuid: prefix from recipients in container mode", async () => {
    setApiMode("container");
    mockContainerSendMessage.mockResolvedValue({ timestamp: 1700000000000 });

    await sendMessageAdapter({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipients: ["uuid:8be17a83-9baf-4b8c-b4f7-397d435cfb1c"],
      message: "Hello",
    });

    expect(mockContainerSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        recipients: ["8be17a83-9baf-4b8c-b4f7-397d435cfb1c"],
      }),
    );
  });

  it("sends to group when groupId provided (native mode)", async () => {
    mockSignalRpcRequest.mockResolvedValue({});

    await sendMessageAdapter({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipients: [],
      groupId: "group-123",
      message: "Hello group",
    });

    expect(mockSignalRpcRequest).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({ groupId: "group-123" }),
      expect.anything(),
    );
  });

  it("includes text styles (native mode)", async () => {
    mockSignalRpcRequest.mockResolvedValue({});

    await sendMessageAdapter({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipients: ["+15550001111"],
      message: "Bold text",
      textStyles: [{ start: 0, length: 4, style: "BOLD" }],
    });

    expect(mockSignalRpcRequest).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({ "text-style": ["0:4:BOLD"] }),
      expect.anything(),
    );
  });

  it("includes attachments (native mode)", async () => {
    mockSignalRpcRequest.mockResolvedValue({});

    await sendMessageAdapter({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipients: ["+15550001111"],
      message: "Photo",
      attachments: ["/path/to/image.jpg"],
    });

    expect(mockSignalRpcRequest).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({ attachments: ["/path/to/image.jpg"] }),
      expect.anything(),
    );
  });
});

describe("sendTypingAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setApiMode("native");
  });

  it("uses native JSON-RPC for native mode", async () => {
    mockSignalRpcRequest.mockResolvedValue({});

    const result = await sendTypingAdapter({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipient: "+15550001111",
    });

    expect(result).toBe(true);
    expect(mockSignalRpcRequest).toHaveBeenCalledWith(
      "sendTyping",
      expect.objectContaining({
        account: "+14259798283",
        recipient: ["+15550001111"],
      }),
      expect.anything(),
    );
  });

  it("uses container REST for container mode", async () => {
    setApiMode("container");
    mockContainerSendTyping.mockResolvedValue(true);

    const result = await sendTypingAdapter({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipient: "+15550001111",
    });

    expect(result).toBe(true);
    expect(mockContainerSendTyping).toHaveBeenCalled();
  });

  it("sends stop typing for native mode", async () => {
    mockSignalRpcRequest.mockResolvedValue({});

    await sendTypingAdapter({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipient: "+15550001111",
      stop: true,
    });

    expect(mockSignalRpcRequest).toHaveBeenCalledWith(
      "sendTyping",
      expect.objectContaining({ stop: true }),
      expect.anything(),
    );
  });
});

describe("sendReceiptAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setApiMode("native");
  });

  it("uses native JSON-RPC for native mode", async () => {
    mockSignalRpcRequest.mockResolvedValue({});

    const result = await sendReceiptAdapter({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipient: "+15550001111",
      targetTimestamp: 1700000000000,
    });

    expect(result).toBe(true);
    expect(mockSignalRpcRequest).toHaveBeenCalledWith(
      "sendReceipt",
      expect.objectContaining({
        account: "+14259798283",
        recipient: ["+15550001111"],
        targetTimestamp: 1700000000000,
        type: "read",
      }),
      expect.anything(),
    );
  });

  it("uses container REST for container mode", async () => {
    setApiMode("container");
    mockContainerSendReceipt.mockResolvedValue(true);

    const result = await sendReceiptAdapter({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipient: "+15550001111",
      targetTimestamp: 1700000000000,
    });

    expect(result).toBe(true);
    expect(mockContainerSendReceipt).toHaveBeenCalled();
  });

  it("respects type parameter", async () => {
    mockSignalRpcRequest.mockResolvedValue({});

    await sendReceiptAdapter({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipient: "+15550001111",
      targetTimestamp: 1700000000000,
      type: "viewed",
    });

    expect(mockSignalRpcRequest).toHaveBeenCalledWith(
      "sendReceipt",
      expect.objectContaining({ type: "viewed" }),
      expect.anything(),
    );
  });
});

describe("adapterRpcRequest (container reaction formatting)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setApiMode("container");
  });

  it("formats groupIds before calling container reactions", async () => {
    mockContainerSendReaction.mockResolvedValue({ timestamp: 1 });

    await adapterRpcRequest(
      "sendReaction",
      {
        account: "+14259798283",
        recipients: ["+15550001111"],
        emoji: "✅",
        targetAuthor: "uuid:123e4567-e89b-12d3-a456-426614174000",
        targetTimestamp: 123,
        groupIds: ["group-123"],
      },
      { baseUrl: "http://localhost:8080" },
    );

    expect(mockContainerSendReaction).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: "group.Z3JvdXAtMTIz",
      }),
    );
    expect(mockContainerRemoveReaction).not.toHaveBeenCalled();
  });
});

describe("fetchAttachmentAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setApiMode("native");
  });

  it("uses native JSON-RPC for native mode with sender", async () => {
    const mockData = "base64data";
    mockSignalRpcRequest.mockResolvedValue({ data: mockData });

    const result = await fetchAttachmentAdapter({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      attachmentId: "attachment-123",
      sender: "+15550001111",
    });

    expect(result).toBeInstanceOf(Buffer);
    expect(mockSignalRpcRequest).toHaveBeenCalledWith(
      "getAttachment",
      expect.objectContaining({
        id: "attachment-123",
        account: "+14259798283",
        recipient: "+15550001111",
      }),
      expect.anything(),
    );
  });

  it("uses container REST for container mode", async () => {
    setApiMode("container");
    const mockBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    mockContainerFetchAttachment.mockResolvedValue(mockBuffer);

    const result = await fetchAttachmentAdapter({
      baseUrl: "http://localhost:8080",
      attachmentId: "attachment-123",
    });

    expect(result).toBe(mockBuffer);
    expect(mockContainerFetchAttachment).toHaveBeenCalledWith(
      "attachment-123",
      expect.objectContaining({ baseUrl: "http://localhost:8080" }),
    );
  });

  it("returns null for native mode without sender or groupId", async () => {
    const result = await fetchAttachmentAdapter({
      baseUrl: "http://localhost:8080",
      attachmentId: "attachment-123",
    });

    expect(result).toBeNull();
    expect(mockSignalRpcRequest).not.toHaveBeenCalled();
  });

  it("uses groupId when provided for native mode", async () => {
    mockSignalRpcRequest.mockResolvedValue({ data: "base64data" });

    await fetchAttachmentAdapter({
      baseUrl: "http://localhost:8080",
      attachmentId: "attachment-123",
      groupId: "group-123",
    });

    expect(mockSignalRpcRequest).toHaveBeenCalledWith(
      "getAttachment",
      expect.objectContaining({ groupId: "group-123" }),
      expect.anything(),
    );
  });

  it("returns null when native RPC returns no data", async () => {
    mockSignalRpcRequest.mockResolvedValue({});

    const result = await fetchAttachmentAdapter({
      baseUrl: "http://localhost:8080",
      attachmentId: "attachment-123",
      sender: "+15550001111",
    });

    expect(result).toBeNull();
  });
});

describe("checkAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setApiMode("native");
  });

  it("uses native check for native mode", async () => {
    setApiMode("native");
    mockSignalCheck.mockResolvedValue({ ok: true, status: 200 });

    const result = await checkAdapter("http://localhost:8080");

    expect(result).toEqual({ ok: true, status: 200 });
    expect(mockSignalCheck).toHaveBeenCalledWith("http://localhost:8080", 10000);
    expect(mockContainerCheck).not.toHaveBeenCalled();
  });

  it("uses container check for container mode", async () => {
    setApiMode("container");
    mockContainerCheck.mockResolvedValue({ ok: true, status: 200 });

    const result = await checkAdapter("http://localhost:8080");

    expect(result).toEqual({ ok: true, status: 200 });
    expect(mockContainerCheck).toHaveBeenCalledWith("http://localhost:8080", 10000);
    expect(mockSignalCheck).not.toHaveBeenCalled();
  });

  it("respects timeout parameter", async () => {
    setApiMode("native");
    mockSignalCheck.mockResolvedValue({ ok: true });

    await checkAdapter("http://localhost:8080", 5000);

    expect(mockSignalCheck).toHaveBeenCalledWith("http://localhost:8080", 5000);
  });
});

describe("streamSignalEventsAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setApiMode("native");
  });

  it("uses native SSE for native mode", async () => {
    mockStreamSignalEvents.mockResolvedValue();

    const onEvent = vi.fn();
    await streamSignalEventsAdapter({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      onEvent,
    });

    expect(mockStreamSignalEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "http://localhost:8080",
        account: "+14259798283",
      }),
    );
    expect(mockStreamContainerEvents).not.toHaveBeenCalled();
  });

  it("uses container WebSocket for container mode", async () => {
    setApiMode("container");
    mockStreamContainerEvents.mockResolvedValue();

    const onEvent = vi.fn();
    await streamSignalEventsAdapter({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      onEvent,
    });

    expect(mockStreamContainerEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "http://localhost:8080",
        account: "+14259798283",
      }),
    );
    expect(mockStreamSignalEvents).not.toHaveBeenCalled();
  });

  it("passes native SSE events through unchanged", async () => {
    const payload = { envelope: { sourceNumber: "+1555000111" } };
    mockStreamSignalEvents.mockImplementation(async (params) => {
      // Simulate receiving an SSE event with event: "receive"
      params.onEvent({ event: "receive", data: JSON.stringify(payload) });
    });

    const events: unknown[] = [];
    await streamSignalEventsAdapter({
      baseUrl: "http://localhost:8080",
      onEvent: (evt) => events.push(evt),
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ event: "receive", data: JSON.stringify(payload) });
  });

  it("passes non-receive native SSE events through unchanged", async () => {
    mockStreamSignalEvents.mockImplementation(async (params) => {
      params.onEvent({ event: "message", data: '{"test": true}' });
    });

    const events: unknown[] = [];
    await streamSignalEventsAdapter({
      baseUrl: "http://localhost:8080",
      onEvent: (evt) => events.push(evt),
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ event: "message", data: '{"test": true}' });
  });

  it("converts container events to SSE-like receive events", async () => {
    setApiMode("container");
    mockStreamContainerEvents.mockImplementation(async (params) => {
      // Simulate receiving an event
      params.onEvent({ envelope: { sourceNumber: "+1555000111" } });
    });

    const events: unknown[] = [];
    await streamSignalEventsAdapter({
      baseUrl: "http://localhost:8080",
      onEvent: (evt) => events.push(evt),
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      event: "receive",
      data: JSON.stringify({ envelope: { sourceNumber: "+1555000111" } }),
    });
  });

  it("passes abort signal to underlying stream", async () => {
    mockStreamSignalEvents.mockResolvedValue();

    const abortController = new AbortController();
    await streamSignalEventsAdapter({
      baseUrl: "http://localhost:8080",
      abortSignal: abortController.signal,
      onEvent: vi.fn(),
    });

    expect(mockStreamSignalEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: abortController.signal,
      }),
    );
  });
});

describe("sendMessageAdapter - additional cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setApiMode("native");
  });

  it("uses groupId as recipient when recipients empty (container mode)", async () => {
    setApiMode("container");
    mockContainerSendMessage.mockResolvedValue({ timestamp: 1700000000000 });

    await sendMessageAdapter({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipients: [],
      groupId: "group-123",
      message: "Hello group",
    });

    // Group ID should be converted to container format: group.{base64(internal_id)}
    expect(mockContainerSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        recipients: ["group.Z3JvdXAtMTIz"], // base64("group-123") = "Z3JvdXAtMTIz"
      }),
    );
  });

  it("converts internal_id to container group format (container mode)", async () => {
    setApiMode("container");
    mockContainerSendMessage.mockResolvedValue({ timestamp: 1700000000000 });

    // Simulate real internal_id format from bbernhard container
    const internalId = "7wtpR8G3OeFouLeAZNW/VUaOYZaCoY0yqhP0Vcdj6Oc=";
    const expectedFormatted = `group.${Buffer.from(internalId).toString("base64")}`;

    await sendMessageAdapter({
      baseUrl: "http://localhost:8080",
      account: "+18286226919",
      recipients: [],
      groupId: internalId,
      message: "Hello group",
    });

    expect(mockContainerSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        recipients: [expectedFormatted],
      }),
    );
  });

  it("preserves already-formatted group IDs (container mode)", async () => {
    setApiMode("container");
    mockContainerSendMessage.mockResolvedValue({ timestamp: 1700000000000 });

    // Already in correct format with group. prefix
    const formattedGroupId = "group.N3d0cFI4RzNPZUZvdUxlQVpOVy9WVWFPWVphQ29ZMHlxaFAwVmNkajZPYz0=";

    await sendMessageAdapter({
      baseUrl: "http://localhost:8080",
      account: "+18286226919",
      recipients: [],
      groupId: formattedGroupId,
      message: "Hello group",
    });

    // Should pass through unchanged since it already has group. prefix
    expect(mockContainerSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        recipients: [formattedGroupId],
      }),
    );
  });

  it("uses empty recipients when no recipients and no groupId (container mode)", async () => {
    setApiMode("container");
    mockContainerSendMessage.mockResolvedValue({});

    await sendMessageAdapter({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipients: [],
      message: "Hello",
    });

    expect(mockContainerSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        recipients: [],
      }),
    );
  });

  it("uses username targets in container mode when recipient is absent", async () => {
    setApiMode("container");
    mockContainerSendMessage.mockResolvedValue({ timestamp: 1700000000000 });

    await adapterRpcRequest(
      "send",
      {
        account: "+14259798283",
        message: "Hello username",
        username: ["alice.01"],
      },
      {
        baseUrl: "http://localhost:8080",
      },
    );

    expect(mockContainerSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        recipients: ["alice.01"],
      }),
    );
  });

  it("returns empty object when native RPC returns null", async () => {
    mockSignalRpcRequest.mockResolvedValue(null);

    const result = await sendMessageAdapter({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipients: ["+15550001111"],
      message: "Hello",
    });

    expect(result).toEqual({});
  });

  it("passes timeout to container send", async () => {
    setApiMode("container");
    mockContainerSendMessage.mockResolvedValue({});

    await sendMessageAdapter({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipients: ["+15550001111"],
      message: "Hello",
      timeoutMs: 30000,
    });

    expect(mockContainerSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 30000,
      }),
    );
  });
});

describe("sendTypingAdapter - additional cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setApiMode("native");
  });

  it("sends to group when groupId provided (native mode)", async () => {
    mockSignalRpcRequest.mockResolvedValue({});

    await sendTypingAdapter({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipient: "+15550001111",
      groupId: "group-123",
    });

    expect(mockSignalRpcRequest).toHaveBeenCalledWith(
      "sendTyping",
      expect.objectContaining({
        groupId: "group-123",
      }),
      expect.anything(),
    );
    // Should not include recipient when groupId is provided
    const callParams = mockSignalRpcRequest.mock.calls[0][1];
    expect(callParams).not.toHaveProperty("recipient");
  });

  it("passes stop flag to container", async () => {
    setApiMode("container");
    mockContainerSendTyping.mockResolvedValue(true);

    await sendTypingAdapter({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipient: "+15550001111",
      stop: true,
    });

    expect(mockContainerSendTyping).toHaveBeenCalledWith(
      expect.objectContaining({
        stop: true,
      }),
    );
  });
});

describe("sendReceiptAdapter - additional cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setApiMode("native");
  });

  it("passes viewed type to container", async () => {
    setApiMode("container");
    mockContainerSendReceipt.mockResolvedValue(true);

    await sendReceiptAdapter({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipient: "+15550001111",
      targetTimestamp: 1700000000000,
      type: "viewed",
    });

    expect(mockContainerSendReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "viewed",
      }),
    );
  });
});

describe("fetchAttachmentAdapter - additional cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setApiMode("native");
  });

  it("prefers groupId over sender when both provided (native mode)", async () => {
    mockSignalRpcRequest.mockResolvedValue({ data: "base64data" });

    await fetchAttachmentAdapter({
      baseUrl: "http://localhost:8080",
      attachmentId: "attachment-123",
      sender: "+15550001111",
      groupId: "group-123",
    });

    const callParams = mockSignalRpcRequest.mock.calls[0][1];
    expect(callParams).toHaveProperty("groupId", "group-123");
    expect(callParams).not.toHaveProperty("recipient");
  });

  it("passes timeout to container fetch", async () => {
    setApiMode("container");
    mockContainerFetchAttachment.mockResolvedValue(Buffer.from([]));

    await fetchAttachmentAdapter({
      baseUrl: "http://localhost:8080",
      attachmentId: "attachment-123",
      timeoutMs: 60000,
    });

    expect(mockContainerFetchAttachment).toHaveBeenCalledWith(
      "attachment-123",
      expect.objectContaining({
        timeoutMs: 60000,
      }),
    );
  });
});
