import { beforeEach, describe, expect, it, vi } from "vitest";
import { removeReactionSignal, sendReactionSignal } from "./send-reactions.js";

const rpcMock = vi.fn();

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({}),
  };
});

vi.mock("./accounts.js", () => ({
  resolveSignalAccount: () => ({
    accountId: "default",
    enabled: true,
    baseUrl: "http://signal.local",
    configured: true,
    config: { account: "+15550001111" },
  }),
}));

vi.mock("./client.js", () => ({
  signalRpcRequest: (...args: unknown[]) => rpcMock(...args),
}));

vi.mock("../infra/channel-activity.js", () => ({
  recordChannelActivity: () => {},
}));

describe("sendReactionSignal", () => {
  beforeEach(() => {
    rpcMock.mockClear().mockResolvedValue({ timestamp: 123, results: [{ type: "SUCCESS" }] });
  });

  it("uses recipients array and targetAuthor for uuid dms", async () => {
    await sendReactionSignal("uuid:123e4567-e89b-12d3-a456-426614174000", 123, "🔥", {
      targetAuthor: "uuid:123e4567-e89b-12d3-a456-426614174000",
    });

    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(rpcMock).toHaveBeenCalledWith("sendReaction", expect.any(Object), expect.any(Object));
    expect(params.recipients).toEqual(["123e4567-e89b-12d3-a456-426614174000"]);
    expect(params.groupIds).toBeUndefined();
    expect(params.targetAuthor).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(params).not.toHaveProperty("recipient");
    expect(params).not.toHaveProperty("groupId");
  });

  it("uses groupIds array and maps targetAuthorUuid", async () => {
    await sendReactionSignal("", 123, "✅", {
      groupId: "group-id",
      targetAuthorUuid: "uuid:123e4567-e89b-12d3-a456-426614174000",
    });

    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.recipients).toBeUndefined();
    expect(params.groupIds).toEqual(["group-id"]);
    expect(params.targetAuthor).toBe("123e4567-e89b-12d3-a456-426614174000");
  });

  it("requires explicit targetAuthor for direct reactions", async () => {
    await expect(removeReactionSignal("+15551230000", 456, "❌")).rejects.toThrow(
      "targetAuthor is required for direct reaction removal",
    );
  });

  it("passes targetAuthor explicitly for removals", async () => {
    await removeReactionSignal("+15551230000", 456, "❌", {
      targetAuthor: "+15551230000",
    });

    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.recipients).toEqual(["+15551230000"]);
    expect(params.targetAuthor).toBe("+15551230000");
    expect(params.remove).toBe(true);
  });

  it("throws on per-recipient failure", async () => {
    rpcMock.mockResolvedValueOnce({
      timestamp: 789,
      results: [{ type: "UNREGISTERED_FAILURE", recipientAddress: { number: "+15559999999" } }],
    });
    await expect(
      sendReactionSignal("+15559999999", 100, "👍", { targetAuthor: "+15559999999" }),
    ).rejects.toThrow("Signal sendReaction failed for recipient result(s):");
  });
});
