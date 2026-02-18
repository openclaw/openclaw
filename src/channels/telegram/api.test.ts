import { describe, expect, it, vi } from "vitest";
import { fetchTelegramChatId } from "./api.js";

describe("fetchTelegramChatId", () => {
  it("returns stringified id when Telegram getChat succeeds", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, result: { id: 12345 } }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const id = await fetchTelegramChatId({
      token: "abc",
      chatId: "@user",
    });

    expect(id).toBe("12345");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/botabc/getChat?chat_id=%40user",
      undefined,
    );
  });

  it("returns null when response is not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => ({}),
      })),
    );

    const id = await fetchTelegramChatId({
      token: "abc",
      chatId: "@user",
    });

    expect(id).toBeNull();
  });

  it("returns null on transport failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network failed");
      }),
    );

    const id = await fetchTelegramChatId({
      token: "abc",
      chatId: "@user",
    });

    expect(id).toBeNull();
  });
});
