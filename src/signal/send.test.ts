import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  sendRemoteDeleteSignal,
  sendPollCreateSignal,
  sendPollVoteSignal,
  sendPollTerminateSignal,
} from "./send.js";

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

describe("sendRemoteDeleteSignal", () => {
  beforeEach(() => {
    rpcMock.mockReset().mockResolvedValue({});
  });

  it("calls remoteDelete RPC with recipient and targetTimestamp", async () => {
    await sendRemoteDeleteSignal("+15551234567", 1234567890);

    expect(rpcMock).toHaveBeenCalledWith(
      "remoteDelete",
      expect.objectContaining({
        recipient: ["+15551234567"],
        targetTimestamp: 1234567890,
        account: "+15550001111",
      }),
      expect.objectContaining({
        baseUrl: "http://signal.local",
      }),
    );
  });

  it("handles group targets", async () => {
    await sendRemoteDeleteSignal("group:xyz123", 9876543210);

    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.groupId).toBe("xyz123");
    expect(params.targetTimestamp).toBe(9876543210);
    expect(params.recipient).toBeUndefined();
  });

  it("handles username targets", async () => {
    await sendRemoteDeleteSignal("username:alice.123", 1111111111);

    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.username).toEqual(["alice.123"]);
    expect(params.targetTimestamp).toBe(1111111111);
    expect(params.recipient).toBeUndefined();
    expect(params.groupId).toBeUndefined();
  });

  it("returns false for invalid timestamps", async () => {
    expect(await sendRemoteDeleteSignal("+15551234567", 0)).toBe(false);
    expect(await sendRemoteDeleteSignal("+15551234567", -1)).toBe(false);
    expect(await sendRemoteDeleteSignal("+15551234567", NaN)).toBe(false);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("returns true on successful delete", async () => {
    const result = await sendRemoteDeleteSignal("+15551234567", 1234567890);
    expect(result).toBe(true);
  });
});

describe("sendPollCreateSignal", () => {
  beforeEach(() => {
    rpcMock.mockReset().mockResolvedValue({ timestamp: 9999999999 });
  });

  it("sends poll create with correct RPC params for recipient target", async () => {
    await sendPollCreateSignal("+15551234567", {
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
    });

    expect(rpcMock).toHaveBeenCalledWith(
      "sendPollCreate",
      expect.objectContaining({
        recipient: ["+15551234567"],
        question: "Lunch?",
        option: ["Pizza", "Sushi"],
        noMulti: false,
        account: "+15550001111",
      }),
      expect.objectContaining({
        baseUrl: "http://signal.local",
      }),
    );
  });

  it("sends poll create for group target", async () => {
    await sendPollCreateSignal("group:abc123", {
      question: "Lunch?",
      options: ["Pizza", "Sushi", "Tacos"],
      allowMultiple: false,
    });

    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.groupId).toBe("abc123");
    expect(params.question).toBe("Lunch?");
    expect(params.option).toEqual(["Pizza", "Sushi", "Tacos"]);
    expect(params.noMulti).toBe(true);
    expect(params.recipient).toBeUndefined();
  });

  it("rejects poll create with empty question", async () => {
    await expect(
      sendPollCreateSignal("+15551234567", {
        question: "   ",
        options: ["Pizza", "Sushi"],
      }),
    ).rejects.toThrow("Poll question is required");

    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("rejects poll create with fewer than two options", async () => {
    await expect(
      sendPollCreateSignal("+15551234567", {
        question: "Lunch?",
        options: ["Pizza"],
      }),
    ).rejects.toThrow("At least two poll options are required");

    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe("sendPollVoteSignal", () => {
  beforeEach(() => {
    rpcMock.mockReset().mockResolvedValue({ timestamp: 9999999999 });
  });

  it("sends poll vote with correct RPC params for recipient target", async () => {
    await sendPollVoteSignal("+15551234567", {
      pollAuthor: "+15559999999",
      pollTimestamp: 1234567890,
      optionIndexes: [0, 2],
    });

    expect(rpcMock).toHaveBeenCalledWith(
      "sendPollVote",
      expect.objectContaining({
        recipient: ["+15551234567"],
        pollAuthor: "+15559999999",
        pollTimestamp: 1234567890,
        option: [0, 2],
        voteCount: 1,
        account: "+15550001111",
      }),
      expect.objectContaining({
        baseUrl: "http://signal.local",
      }),
    );
  });

  it("sends poll vote for group target", async () => {
    await sendPollVoteSignal("group:abc123", {
      pollAuthor: "+15559999999",
      pollTimestamp: 9876543210,
      optionIndexes: [1],
    });

    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.groupId).toBe("abc123");
    expect(params.pollAuthor).toBe("+15559999999");
    expect(params.pollTimestamp).toBe(9876543210);
    expect(params.option).toEqual([1]);
    expect(params.recipient).toBeUndefined();
  });

  it("rejects poll vote with invalid timestamp", async () => {
    await expect(
      sendPollVoteSignal("+15551234567", {
        pollAuthor: "+15559999999",
        pollTimestamp: 0,
        optionIndexes: [0],
      }),
    ).rejects.toThrow("Invalid poll timestamp");

    await expect(
      sendPollVoteSignal("+15551234567", {
        pollAuthor: "+15559999999",
        pollTimestamp: -100,
        optionIndexes: [0],
      }),
    ).rejects.toThrow("Invalid poll timestamp");

    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("rejects poll vote with empty option indexes", async () => {
    await expect(
      sendPollVoteSignal("+15551234567", {
        pollAuthor: "+15559999999",
        pollTimestamp: 1234567890,
        optionIndexes: [],
      }),
    ).rejects.toThrow("At least one poll option must be selected");

    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("rejects poll vote with empty poll author", async () => {
    await expect(
      sendPollVoteSignal("+15551234567", {
        pollAuthor: "",
        pollTimestamp: 1234567890,
        optionIndexes: [0],
      }),
    ).rejects.toThrow("Poll author is required");

    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("accepts custom voteCount", async () => {
    await sendPollVoteSignal("+15551234567", {
      pollAuthor: "+15559999999",
      pollTimestamp: 1234567890,
      optionIndexes: [1],
      voteCount: 3,
    });

    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.voteCount).toBe(3);
  });
});

describe("sendPollTerminateSignal", () => {
  beforeEach(() => {
    rpcMock.mockReset().mockResolvedValue({ timestamp: 9999999999 });
  });

  it("sends poll terminate with correct RPC params", async () => {
    await sendPollTerminateSignal("+15551234567", {
      pollTimestamp: 1234567890,
    });

    expect(rpcMock).toHaveBeenCalledWith(
      "sendPollTerminate",
      expect.objectContaining({
        recipient: ["+15551234567"],
        pollTimestamp: 1234567890,
        notifySelf: false,
        account: "+15550001111",
      }),
      expect.objectContaining({
        baseUrl: "http://signal.local",
      }),
    );
  });

  it("sends poll terminate for group target", async () => {
    await sendPollTerminateSignal("group:xyz789", {
      pollTimestamp: 9876543210,
    });

    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.groupId).toBe("xyz789");
    expect(params.pollTimestamp).toBe(9876543210);
    expect(params.notifySelf).toBe(false);
    expect(params.recipient).toBeUndefined();
  });

  it("rejects poll terminate with invalid timestamp", async () => {
    await expect(
      sendPollTerminateSignal("+15551234567", {
        pollTimestamp: 0,
      }),
    ).rejects.toThrow("Invalid poll timestamp");

    await expect(
      sendPollTerminateSignal("+15551234567", {
        pollTimestamp: -1,
      }),
    ).rejects.toThrow("Invalid poll timestamp");

    expect(rpcMock).not.toHaveBeenCalled();
  });
});
