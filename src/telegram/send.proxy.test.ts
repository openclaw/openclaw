import { beforeEach, describe, expect, it, vi } from "vitest";

const { botApi, botCtorSpy } = vi.hoisted(() => ({
  botApi: {
    sendMessage: vi.fn(),
    setMessageReaction: vi.fn(),
    deleteMessage: vi.fn(),
  },
  botCtorSpy: vi.fn(),
}));

const { loadConfig } = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
}));

const { makeProxyFetch } = vi.hoisted(() => ({
  makeProxyFetch: vi.fn(),
}));

const { resolveTelegramFetch } = vi.hoisted(() => ({
  resolveTelegramFetch: vi.fn(),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig,
  };
});

vi.mock("./proxy.js", () => ({
  makeProxyFetch,
}));

vi.mock("./fetch.js", () => ({
  resolveTelegramFetch,
}));

vi.mock("grammy", () => ({
  Bot: class {
    api = botApi;
    catch = vi.fn();
    constructor(
      public token: string,
      public options?: { client?: { fetch?: typeof fetch; timeoutSeconds?: number } },
    ) {
      botCtorSpy(token, options);
    }
  },
  InputFile: class {},
}));

import { deleteMessageTelegram, reactMessageTelegram, sendMessageTelegram } from "./send.js";

describe("telegram proxy client", () => {
  const proxyUrl = "http://proxy.test:8080";

  const prepareProxyFetch = () => {
    const proxyFetch = vi.fn();
    const fetchImpl = vi.fn();
    makeProxyFetch.mockReturnValue(proxyFetch as unknown as typeof fetch);
    resolveTelegramFetch.mockReturnValue(fetchImpl as unknown as typeof fetch);
    return { proxyFetch, fetchImpl };
  };

  const expectProxyClient = (fetchImpl: ReturnType<typeof vi.fn>) => {
    expect(makeProxyFetch).toHaveBeenCalledWith(proxyUrl);
    expect(resolveTelegramFetch).toHaveBeenCalledWith(expect.any(Function), { network: undefined });
    expect(botCtorSpy).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({
        client: expect.objectContaining({ fetch: fetchImpl }),
      }),
    );
  };

  beforeEach(() => {
    botApi.sendMessage.mockResolvedValue({ message_id: 1, chat: { id: "123" } });
    botApi.setMessageReaction.mockResolvedValue(undefined);
    botApi.deleteMessage.mockResolvedValue(true);
    botCtorSpy.mockClear();
    loadConfig.mockReturnValue({
      channels: { telegram: { accounts: { foo: { proxy: proxyUrl } } } },
    });
    makeProxyFetch.mockClear();
    resolveTelegramFetch.mockClear();
  });

  it.each([
    {
      name: "sendMessage",
      run: () => sendMessageTelegram("123", "hi", { token: "tok", accountId: "foo" }),
    },
    {
      name: "reactions",
      run: () => reactMessageTelegram("123", "456", "✅", { token: "tok", accountId: "foo" }),
    },
    {
      name: "deleteMessage",
      run: () => deleteMessageTelegram("123", "456", { token: "tok", accountId: "foo" }),
    },
  ])("uses proxy fetch for $name", async (testCase) => {
    const { fetchImpl } = prepareProxyFetch();

    await testCase.run();

    expectProxyClient(fetchImpl);
  });
});
