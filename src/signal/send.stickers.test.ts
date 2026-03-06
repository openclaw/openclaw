import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendStickerSignal, listStickerPacksSignal } from "./send.js";

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

describe("sendStickerSignal", () => {
  beforeEach(() => {
    rpcMock.mockClear().mockResolvedValue({ timestamp: 1700000000000 });
  });

  it("sends sticker with packId:stickerId format to recipient", async () => {
    const result = await sendStickerSignal("+15559990000", "abc123", 3);

    expect(rpcMock).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        recipient: ["+15559990000"],
        sticker: "abc123:3",
      }),
      expect.any(Object),
    );
    expect(result.messageId).toBe("1700000000000");
    expect(result.timestamp).toBe(1700000000000);
  });

  it("sends sticker to a group target", async () => {
    await sendStickerSignal("group:mygroup", "pack1", 0);

    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.groupId).toBe("mygroup");
    expect(params.sticker).toBe("pack1:0");
    expect(params.recipient).toBeUndefined();
  });

  it("sends sticker to a username target", async () => {
    await sendStickerSignal("username:alice.42", "pack2", 7);

    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.username).toEqual(["alice.42"]);
    expect(params.sticker).toBe("pack2:7");
  });

  it("includes account when resolved from config", async () => {
    await sendStickerSignal("+15551234567", "pack1", 1);

    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.account).toBe("+15550001111");
  });

  it("truncates fractional sticker IDs", async () => {
    await sendStickerSignal("+15551234567", "pack1", 2.9);

    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.sticker).toBe("pack1:2");
  });

  it("throws for empty packId", async () => {
    await expect(sendStickerSignal("+15551234567", "  ", 1)).rejects.toThrow(
      "Signal sticker send requires packId",
    );
  });

  it("throws for negative stickerId", async () => {
    await expect(sendStickerSignal("+15551234567", "pack1", -1)).rejects.toThrow(
      "Signal sticker send requires a non-negative stickerId",
    );
  });

  it("throws for NaN stickerId", async () => {
    await expect(sendStickerSignal("+15551234567", "pack1", Number.NaN)).rejects.toThrow(
      "Signal sticker send requires a non-negative stickerId",
    );
  });

  it("throws for empty recipient", async () => {
    await expect(sendStickerSignal("", "pack1", 1)).rejects.toThrow("Signal recipient is required");
  });

  it("returns 'unknown' messageId when no timestamp in response", async () => {
    rpcMock.mockResolvedValue({});
    const result = await sendStickerSignal("+15551234567", "pack1", 0);
    expect(result.messageId).toBe("unknown");
    expect(result.timestamp).toBeUndefined();
  });
});

describe("listStickerPacksSignal", () => {
  beforeEach(() => {
    rpcMock.mockClear();
  });

  it("returns packs from array response", async () => {
    const packs = [
      { packId: "pack1", title: "Cats", author: "Alice", installed: true },
      { packId: "pack2", title: "Dogs", author: "Bob", installed: false },
    ];
    rpcMock.mockResolvedValue(packs);

    const result = await listStickerPacksSignal();

    expect(rpcMock).toHaveBeenCalledWith(
      "listStickerPacks",
      expect.objectContaining({ account: "+15550001111" }),
      expect.any(Object),
    );
    expect(result).toEqual(packs);
  });

  it("normalizes stickerPacks wrapper object", async () => {
    const packs = [{ packId: "p1", title: "Stars" }];
    rpcMock.mockResolvedValue({ stickerPacks: packs });

    const result = await listStickerPacksSignal();
    expect(result).toEqual(packs);
  });

  it("returns empty array for null response", async () => {
    rpcMock.mockResolvedValue(null);
    const result = await listStickerPacksSignal();
    expect(result).toEqual([]);
  });

  it("returns empty array for non-array, non-object response", async () => {
    rpcMock.mockResolvedValue("unexpected");
    const result = await listStickerPacksSignal();
    expect(result).toEqual([]);
  });

  it("returns empty array for object without stickerPacks key", async () => {
    rpcMock.mockResolvedValue({ other: "data" });
    const result = await listStickerPacksSignal();
    expect(result).toEqual([]);
  });
});
