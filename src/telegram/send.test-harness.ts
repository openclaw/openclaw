import { beforeEach, vi } from "vitest";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";

const { botApi, botCtorSpy } = vi.hoisted(() => ({
  botApi: {
    sendMessage: vi.fn(),
    sendPhoto: vi.fn(),
    sendVideo: vi.fn(),
    sendVideoNote: vi.fn(),
    setMessageReaction: vi.fn(),
    sendSticker: vi.fn(),
  },
  botCtorSpy: vi.fn(),
}));

const { loadWebMedia } = vi.hoisted(() => ({
  loadWebMedia: vi.fn(),
}));

const { loadConfig } = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
}));

type TelegramSendTestMocks = {
  botApi: Record<string, MockFn>;
  botCtorSpy: MockFn;
  loadConfig: MockFn;
  loadWebMedia: MockFn;
};

vi.mock("../web/media.js", () => ({
  loadWebMedia,
}));

vi.mock("grammy", () => ({
  Bot: class {
    api = botApi;
    catch = vi.fn();
    constructor(
      public token: string,
      public options?: {
        client?: { fetch?: typeof fetch; timeoutSeconds?: number };
      },
    ) {
      botCtorSpy(token, options);
    }
  },
  InputFile: class {},
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig,
  };
});

export function getTelegramSendTestMocks(): TelegramSendTestMocks {
  return { botApi, botCtorSpy, loadConfig, loadWebMedia };
}

export function installTelegramSendTestHooks() {
  beforeEach(() => {
    loadConfig.mockReturnValue({});
    loadWebMedia.mockReset();
    botCtorSpy.mockReset();
    for (const fn of Object.values(botApi)) {
      fn.mockReset();
    }
  });
}

export async function importTelegramSendModule() {
  return await import("./send.js");
}
