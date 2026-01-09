import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { CliDeps } from "../cli/deps.js";
import type { RuntimeEnv } from "../runtime.js";
import { messagePollCommand, messageSendCommand } from "./message.js";

let testConfig: Record<string, unknown> = {};
vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => testConfig,
  };
});

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
  randomIdempotencyKey: () => "idem-1",
}));

const originalTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
const originalDiscordToken = process.env.DISCORD_BOT_TOKEN;

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = "token-abc";
  process.env.DISCORD_BOT_TOKEN = "token-discord";
  testConfig = {};
});

afterAll(() => {
  process.env.TELEGRAM_BOT_TOKEN = originalTelegramToken;
  process.env.DISCORD_BOT_TOKEN = originalDiscordToken;
});

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(() => {
    throw new Error("exit");
  }),
};

const makeDeps = (overrides: Partial<CliDeps> = {}): CliDeps => ({
  sendMessageWhatsApp: vi.fn(),
  sendMessageTelegram: vi.fn(),
  sendMessageDiscord: vi.fn(),
  sendMessageSlack: vi.fn(),
  sendMessageSignal: vi.fn(),
  sendMessageIMessage: vi.fn(),
  ...overrides,
});

describe("messageSendCommand", () => {
  it("skips send on dry-run", async () => {
    const deps = makeDeps();
    await messageSendCommand(
      {
        to: "+1",
        message: "hi",
        dryRun: true,
      },
      deps,
      runtime,
    );
    expect(deps.sendMessageWhatsApp).not.toHaveBeenCalled();
  });

  it("sends via gateway", async () => {
    callGatewayMock.mockResolvedValueOnce({ messageId: "g1" });
    const deps = makeDeps();
    await messageSendCommand(
      {
        to: "+1",
        message: "hi",
      },
      deps,
      runtime,
    );
    expect(callGatewayMock).toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("g1"));
  });

  it("does not override remote gateway URL", async () => {
    callGatewayMock.mockResolvedValueOnce({ messageId: "g2" });
    testConfig = {
      gateway: { mode: "remote", remote: { url: "wss://remote.example" } },
    };
    const deps = makeDeps();
    await messageSendCommand(
      {
        to: "+1",
        message: "hi",
      },
      deps,
      runtime,
    );
    const args = callGatewayMock.mock.calls.at(-1)?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(args?.url).toBeUndefined();
  });

  it("passes gifPlayback to gateway send", async () => {
    callGatewayMock.mockClear();
    callGatewayMock.mockResolvedValueOnce({ messageId: "g1" });
    const deps = makeDeps();
    await messageSendCommand(
      {
        to: "+1",
        message: "hi",
        gifPlayback: true,
      },
      deps,
      runtime,
    );
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "send",
        params: expect.objectContaining({ gifPlayback: true }),
      }),
    );
  });

  it("routes to telegram provider", async () => {
    const deps = makeDeps({
      sendMessageTelegram: vi
        .fn()
        .mockResolvedValue({ messageId: "t1", chatId: "123" }),
    });
    testConfig = { telegram: { botToken: "token-abc" } };
    await messageSendCommand(
      { to: "123", message: "hi", provider: "telegram" },
      deps,
      runtime,
    );
    expect(deps.sendMessageTelegram).toHaveBeenCalledWith(
      "123",
      "hi",
      expect.objectContaining({ accountId: undefined, verbose: false }),
    );
    expect(deps.sendMessageWhatsApp).not.toHaveBeenCalled();
  });

  it("uses config token for telegram when env is missing", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "";
    testConfig = { telegram: { botToken: "cfg-token" } };
    const deps = makeDeps({
      sendMessageTelegram: vi
        .fn()
        .mockResolvedValue({ messageId: "t1", chatId: "123" }),
    });
    await messageSendCommand(
      { to: "123", message: "hi", provider: "telegram" },
      deps,
      runtime,
    );
    expect(deps.sendMessageTelegram).toHaveBeenCalledWith(
      "123",
      "hi",
      expect.objectContaining({ accountId: undefined, verbose: false }),
    );
  });

  it("routes to discord provider", async () => {
    const deps = makeDeps({
      sendMessageDiscord: vi
        .fn()
        .mockResolvedValue({ messageId: "d1", channelId: "chan" }),
    });
    await messageSendCommand(
      { to: "channel:chan", message: "hi", provider: "discord" },
      deps,
      runtime,
    );
    expect(deps.sendMessageDiscord).toHaveBeenCalledWith(
      "channel:chan",
      "hi",
      expect.objectContaining({ verbose: false }),
    );
    expect(deps.sendMessageWhatsApp).not.toHaveBeenCalled();
  });

  it("routes to signal provider", async () => {
    const deps = makeDeps({
      sendMessageSignal: vi.fn().mockResolvedValue({ messageId: "s1" }),
    });
    await messageSendCommand(
      { to: "+15551234567", message: "hi", provider: "signal" },
      deps,
      runtime,
    );
    expect(deps.sendMessageSignal).toHaveBeenCalledWith(
      "+15551234567",
      "hi",
      expect.objectContaining({ maxBytes: undefined }),
    );
    expect(deps.sendMessageWhatsApp).not.toHaveBeenCalled();
  });

  it("routes to slack provider", async () => {
    const deps = makeDeps({
      sendMessageSlack: vi
        .fn()
        .mockResolvedValue({ messageId: "s1", channelId: "C123" }),
    });
    await messageSendCommand(
      { to: "channel:C123", message: "hi", provider: "slack" },
      deps,
      runtime,
    );
    expect(deps.sendMessageSlack).toHaveBeenCalledWith(
      "channel:C123",
      "hi",
      expect.objectContaining({ accountId: undefined }),
    );
    expect(deps.sendMessageWhatsApp).not.toHaveBeenCalled();
  });

  it("routes to imessage provider", async () => {
    const deps = makeDeps({
      sendMessageIMessage: vi.fn().mockResolvedValue({ messageId: "i1" }),
    });
    await messageSendCommand(
      { to: "chat_id:42", message: "hi", provider: "imessage" },
      deps,
      runtime,
    );
    expect(deps.sendMessageIMessage).toHaveBeenCalledWith(
      "chat_id:42",
      "hi",
      expect.objectContaining({ maxBytes: undefined }),
    );
    expect(deps.sendMessageWhatsApp).not.toHaveBeenCalled();
  });

  it("emits json output", async () => {
    callGatewayMock.mockResolvedValueOnce({ messageId: "direct2" });
    const deps = makeDeps();
    await messageSendCommand(
      {
        to: "+1",
        message: "hi",
        json: true,
      },
      deps,
      runtime,
    );
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining('"provider": "whatsapp"'),
    );
  });
});

describe("messagePollCommand", () => {
  const deps: CliDeps = {
    sendMessageWhatsApp: vi.fn(),
    sendMessageTelegram: vi.fn(),
    sendMessageDiscord: vi.fn(),
    sendMessageSlack: vi.fn(),
    sendMessageSignal: vi.fn(),
    sendMessageIMessage: vi.fn(),
  };

  beforeEach(() => {
    callGatewayMock.mockReset();
    runtime.log.mockReset();
    runtime.error.mockReset();
    runtime.exit.mockReset();
    testConfig = {};
  });

  it("routes through gateway", async () => {
    callGatewayMock.mockResolvedValueOnce({ messageId: "p1" });
    await messagePollCommand(
      {
        to: "+1",
        question: "hi?",
        option: ["y", "n"],
      },
      deps,
      runtime,
    );
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: "poll" }),
    );
  });

  it("does not override remote gateway URL", async () => {
    callGatewayMock.mockResolvedValueOnce({ messageId: "p1" });
    testConfig = {
      gateway: { mode: "remote", remote: { url: "wss://remote.example" } },
    };
    await messagePollCommand(
      {
        to: "+1",
        question: "hi?",
        option: ["y", "n"],
      },
      deps,
      runtime,
    );
    const args = callGatewayMock.mock.calls.at(-1)?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(args?.url).toBeUndefined();
  });

  it("emits json output with gateway metadata", async () => {
    callGatewayMock.mockResolvedValueOnce({ messageId: "p1", channelId: "C1" });
    await messagePollCommand(
      {
        to: "channel:C1",
        question: "hi?",
        option: ["y", "n"],
        provider: "discord",
        json: true,
      },
      deps,
      runtime,
    );
    const lastLog = runtime.log.mock.calls.at(-1)?.[0] as string | undefined;
    expect(lastLog).toBeDefined();
    const payload = JSON.parse(lastLog ?? "{}") as Record<string, unknown>;
    expect(payload).toMatchObject({
      provider: "discord",
      via: "gateway",
      to: "channel:C1",
      messageId: "p1",
      channelId: "C1",
      mediaUrl: null,
      question: "hi?",
      options: ["y", "n"],
      maxSelections: 1,
      durationHours: null,
    });
  });
});
