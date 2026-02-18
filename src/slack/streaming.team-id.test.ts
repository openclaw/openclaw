import { describe, expect, it, vi } from "vitest";

// Mock the ChatStreamer
const mockAppend = vi.fn().mockResolvedValue({});
const mockStop = vi.fn().mockResolvedValue({});

const mockChatStream = vi.fn().mockReturnValue({
  append: mockAppend,
  stop: mockStop,
});

vi.mock("../globals.js", () => ({
  logVerbose: () => {},
}));

// Import after mocks
const { startSlackStream } = await import("./streaming.js");

describe("startSlackStream multi-workspace support (#19791)", () => {
  it("passes recipient_team_id and recipient_user_id to chatStream", async () => {
    const client = { chatStream: mockChatStream } as any;

    await startSlackStream({
      client,
      channel: "C123",
      threadTs: "1700000001.123456",
      recipientTeamId: "T0WORKSPACE2",
      recipientUserId: "U0SENDER",
    });

    expect(mockChatStream).toHaveBeenCalledWith({
      channel: "C123",
      thread_ts: "1700000001.123456",
      recipient_team_id: "T0WORKSPACE2",
      recipient_user_id: "U0SENDER",
    });
  });

  it("omits recipient fields when not provided (DM case)", async () => {
    mockChatStream.mockClear();
    const client = { chatStream: mockChatStream } as any;

    await startSlackStream({
      client,
      channel: "D456",
      threadTs: "1700000002.654321",
    });

    expect(mockChatStream).toHaveBeenCalledWith({
      channel: "D456",
      thread_ts: "1700000002.654321",
    });
  });

  it("includes recipient_team_id without recipient_user_id", async () => {
    mockChatStream.mockClear();
    const client = { chatStream: mockChatStream } as any;

    await startSlackStream({
      client,
      channel: "C789",
      threadTs: "1700000003.000000",
      recipientTeamId: "T0ONLY",
    });

    expect(mockChatStream).toHaveBeenCalledWith({
      channel: "C789",
      thread_ts: "1700000003.000000",
      recipient_team_id: "T0ONLY",
    });
  });
});
