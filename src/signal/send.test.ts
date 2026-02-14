import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendRemoteDeleteSignal } from "./send.js";

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
