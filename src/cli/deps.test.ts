import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultDeps } from "./deps.js";

const moduleLoads = vi.hoisted(() => ({
  whatsapp: vi.fn(),
  telegram: vi.fn(),
  discord: vi.fn(),
  slack: vi.fn(),
  signal: vi.fn(),
  imessage: vi.fn(),
}));

const sendFns = vi.hoisted(() => ({
  whatsapp: vi.fn(async () => ({ messageId: "w1", toJid: "whatsapp:1" })),
  telegram: vi.fn(async () => ({ messageId: "t1", chatId: "telegram:1" })),
  discord: vi.fn(async () => ({ messageId: "d1", channelId: "discord:1" })),
  slack: vi.fn(async () => ({ messageId: "s1", channelId: "slack:1" })),
  signal: vi.fn(async () => ({ messageId: "sg1", conversationId: "signal:1" })),
  imessage: vi.fn(async () => ({ messageId: "i1", chatId: "imessage:1" })),
}));

vi.mock("../channels/web/index.js", () => {
  moduleLoads.whatsapp();
  return { sendMessageWhatsApp: sendFns.whatsapp };
});

vi.mock("../telegram/send.js", () => {
  moduleLoads.telegram();
  return { sendMessageTelegram: sendFns.telegram };
});

vi.mock("../discord/send.js", () => {
  moduleLoads.discord();
  return { sendMessageDiscord: sendFns.discord };
});

vi.mock("../slack/send.js", () => {
  moduleLoads.slack();
  return { sendMessageSlack: sendFns.slack };
});

vi.mock("../signal/send.js", () => {
  moduleLoads.signal();
  return { sendMessageSignal: sendFns.signal };
});

vi.mock("../imessage/send.js", () => {
  moduleLoads.imessage();
  return { sendMessageIMessage: sendFns.imessage };
});

describe("createDefaultDeps", () => {
  function expectUnusedModulesNotLoaded(exclude: keyof typeof moduleLoads): void {
    const keys = Object.keys(moduleLoads) as Array<keyof typeof moduleLoads>;
    for (const key of keys) {
      if (key === exclude) {
        continue;
      }
      expect(moduleLoads[key]).not.toHaveBeenCalled();
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not load provider modules until a dependency is used", async () => {
    const deps = createDefaultDeps();

    expect(moduleLoads.whatsapp).not.toHaveBeenCalled();
    expect(moduleLoads.telegram).not.toHaveBeenCalled();
    expect(moduleLoads.discord).not.toHaveBeenCalled();
    expect(moduleLoads.slack).not.toHaveBeenCalled();
    expect(moduleLoads.signal).not.toHaveBeenCalled();
    expect(moduleLoads.imessage).not.toHaveBeenCalled();

    const sendTelegram = deps.sendMessageTelegram as unknown as (
      ...args: unknown[]
    ) => Promise<unknown>;
    await sendTelegram("chat", "hello", { verbose: false });

    expect(moduleLoads.telegram).toHaveBeenCalledTimes(1);
    expect(sendFns.telegram).toHaveBeenCalledTimes(1);
    expectUnusedModulesNotLoaded("telegram");
  });

  it("reuses module cache after first dynamic import", async () => {
    const deps = createDefaultDeps();
    const sendDiscord = deps.sendMessageDiscord as unknown as (
      ...args: unknown[]
    ) => Promise<unknown>;

    await sendDiscord("channel", "first", { verbose: false });
    await sendDiscord("channel", "second", { verbose: false });

    expect(moduleLoads.discord).toHaveBeenCalledTimes(1);
    expect(sendFns.discord).toHaveBeenCalledTimes(2);
  });
});
