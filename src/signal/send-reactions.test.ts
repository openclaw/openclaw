import { beforeEach, describe, expect, it, vi } from "vitest";
import { removeReactionSignal, sendReactionSignal } from "./send-reactions.js";

const adapterRpcRequestMock = vi.fn();

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

vi.mock("./client-adapter.js", () => ({
  adapterRpcRequest: (...args: unknown[]) => adapterRpcRequestMock(...args),
}));

describe("sendReactionSignal", () => {
  beforeEach(() => {
    adapterRpcRequestMock.mockReset().mockResolvedValue({ timestamp: 123 });
  });

  it("uses recipients array and targetAuthor for uuid dms", async () => {
    await sendReactionSignal("uuid:123e4567-e89b-12d3-a456-426614174000", 123, "🔥");

    expect(adapterRpcRequestMock).toHaveBeenCalledOnce();
    const [method, params] = adapterRpcRequestMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(method).toBe("sendReaction");
    expect(params.recipients).toEqual(["123e4567-e89b-12d3-a456-426614174000"]);
    expect(params.groupIds).toBeUndefined();
    expect(params.targetAuthor).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(params.emoji).toBe("🔥");
    expect(params.targetTimestamp).toBe(123);
  });

  it("uses groupId and maps targetAuthorUuid", async () => {
    await sendReactionSignal("", 123, "✅", {
      groupId: "group-id",
      targetAuthorUuid: "uuid:123e4567-e89b-12d3-a456-426614174000",
    });

    expect(adapterRpcRequestMock).toHaveBeenCalledOnce();
    const [method, params] = adapterRpcRequestMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(method).toBe("sendReaction");
    expect(params.groupIds).toEqual(["group-id"]);
    expect(params.targetAuthor).toBe("123e4567-e89b-12d3-a456-426614174000");
  });

  it("defaults targetAuthor to recipient for removals", async () => {
    adapterRpcRequestMock.mockReset().mockResolvedValue({ timestamp: 456 });
    await removeReactionSignal("+15551230000", 456, "❌");

    expect(adapterRpcRequestMock).toHaveBeenCalledOnce();
    const [method, params] = adapterRpcRequestMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(method).toBe("sendReaction");
    expect(params.recipients).toEqual(["+15551230000"]);
    expect(params.targetAuthor).toBe("+15551230000");
    expect(params.emoji).toBe("❌");
    expect(params.targetTimestamp).toBe(456);
    expect(params.remove).toBe(true);
  });
});
