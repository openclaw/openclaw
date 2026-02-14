import { beforeEach, describe, expect, it, vi } from "vitest";
import { removeReactionSignal, sendReactionSignal } from "./send-reactions.js";

const sendReactionAdapterMock = vi.fn();
const removeReactionAdapterMock = vi.fn();

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
  sendReactionAdapter: (...args: unknown[]) => sendReactionAdapterMock(...args),
  removeReactionAdapter: (...args: unknown[]) => removeReactionAdapterMock(...args),
}));

describe("sendReactionSignal", () => {
  beforeEach(() => {
    sendReactionAdapterMock.mockReset().mockResolvedValue({ timestamp: 123 });
    removeReactionAdapterMock.mockReset().mockResolvedValue({ timestamp: 456 });
  });

  it("uses recipients array and targetAuthor for uuid dms", async () => {
    await sendReactionSignal("uuid:123e4567-e89b-12d3-a456-426614174000", 123, "🔥");

    expect(sendReactionAdapterMock).toHaveBeenCalledOnce();
    const params = sendReactionAdapterMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.recipient).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(params.groupId).toBeUndefined();
    expect(params.targetAuthor).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(params.emoji).toBe("🔥");
    expect(params.targetTimestamp).toBe(123);
  });

  it("uses groupId and maps targetAuthorUuid", async () => {
    await sendReactionSignal("", 123, "✅", {
      groupId: "group-id",
      targetAuthorUuid: "uuid:123e4567-e89b-12d3-a456-426614174000",
    });

    expect(sendReactionAdapterMock).toHaveBeenCalledOnce();
    const params = sendReactionAdapterMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.recipient).toBe("");
    expect(params.groupId).toBe("group-id");
    expect(params.targetAuthor).toBe("123e4567-e89b-12d3-a456-426614174000");
  });

  it("defaults targetAuthor to recipient for removals", async () => {
    await removeReactionSignal("+15551230000", 456, "❌");

    expect(removeReactionAdapterMock).toHaveBeenCalledOnce();
    const params = removeReactionAdapterMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.recipient).toBe("+15551230000");
    expect(params.targetAuthor).toBe("+15551230000");
    expect(params.emoji).toBe("❌");
    expect(params.targetTimestamp).toBe(456);
  });
});
