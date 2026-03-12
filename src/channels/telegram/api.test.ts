import { describe, expect, it, vi } from "vitest";
import { fetchTelegramChatId } from "./api.js";

describe("fetchTelegramChatId", () => {
  const cases = [
    {
      name: "returns stringified id when Telegram getChat succeeds",
      fetchImpl: vi.fn(async () => ({
        ok: true,
        json: async () => ({ ok: true, result: { id: 12345 } }),
      })),
      expected: "12345",
    },
    {
      name: "returns null when response is not ok",
      fetchImpl: vi.fn(async () => ({
        ok: false,
        json: async () => ({}),
      })),
      expected: null,
    },
    {
      name: "returns null on transport failures",
      fetchImpl: vi.fn(async () => {
        throw new Error("network failed");
      }),
      expected: null,
    },
  ] as const;

  for (const testCase of cases) {
    it(testCase.name, async () => {
      vi.stubGlobal("fetch", testCase.fetchImpl);

      const id = await fetchTelegramChatId({
        token: "abc",
        chatId: "@user",
      });

      expect(id).toBe(testCase.expected);
    });
  }

  it("calls Telegram getChat endpoint", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, result: { id: 12345 } }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchTelegramChatId({ token: "abc", chatId: "@user" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/botabc/getChat?chat_id=%40user",
      undefined,
    );
  });
});
