import { beforeEach, describe, expect, it, vi } from "vitest";

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

const whatsappBoundaryLoads = vi.hoisted(() => vi.fn());

vi.mock("../plugins/runtime/runtime-whatsapp-boundary.js", async (importOriginal) => {
  whatsappBoundaryLoads();
  return await importOriginal<typeof import("../plugins/runtime/runtime-whatsapp-boundary.js")>();
});

vi.mock("./send-runtime/whatsapp.js", () => {
  moduleLoads.whatsapp();
  return { runtimeSend: { sendMessage: sendFns.whatsapp } };
});

vi.mock("./send-runtime/telegram.js", () => {
  moduleLoads.telegram();
  return { runtimeSend: { sendMessage: sendFns.telegram } };
});

vi.mock("./send-runtime/discord.js", () => {
  moduleLoads.discord();
  return { runtimeSend: { sendMessage: sendFns.discord } };
});

vi.mock("./send-runtime/slack.js", () => {
  moduleLoads.slack();
  return { runtimeSend: { sendMessage: sendFns.slack } };
});

vi.mock("./send-runtime/signal.js", () => {
  moduleLoads.signal();
  return { runtimeSend: { sendMessage: sendFns.signal } };
});

vi.mock("./send-runtime/imessage.js", () => {
  moduleLoads.imessage();
  return { runtimeSend: { sendMessage: sendFns.imessage } };
});

describe("createDefaultDeps", () => {
  async function loadCreateDefaultDeps() {
    return (await import("./deps.js")).createDefaultDeps;
  }

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
    vi.resetModules();
  });

  it("does not load provider modules until a dependency is used", async () => {
    const createDefaultDeps = await loadCreateDefaultDeps();
    const deps = createDefaultDeps();

    expect(moduleLoads.whatsapp).not.toHaveBeenCalled();
    expect(moduleLoads.telegram).not.toHaveBeenCalled();
    expect(moduleLoads.discord).not.toHaveBeenCalled();
    expect(moduleLoads.slack).not.toHaveBeenCalled();
    expect(moduleLoads.signal).not.toHaveBeenCalled();
    expect(moduleLoads.imessage).not.toHaveBeenCalled();

    const sendTelegram = deps["telegram"] as (...args: unknown[]) => Promise<unknown>;
    await sendTelegram("chat", "hello", { verbose: false });

    expect(moduleLoads.telegram).toHaveBeenCalledTimes(1);
    expect(sendFns.telegram).toHaveBeenCalledTimes(1);
    expectUnusedModulesNotLoaded("telegram");
  });

  it("reuses module cache after first dynamic import", async () => {
    const createDefaultDeps = await loadCreateDefaultDeps();
    const deps = createDefaultDeps();
    const sendDiscord = deps["discord"] as (...args: unknown[]) => Promise<unknown>;

    await sendDiscord("channel", "first", { verbose: false });
    await sendDiscord("channel", "second", { verbose: false });

    expect(moduleLoads.discord).toHaveBeenCalledTimes(1);
    expect(sendFns.discord).toHaveBeenCalledTimes(2);
  });

  it("does not import the whatsapp runtime boundary on deps module load", async () => {
    await import("./deps.js");

    expect(whatsappBoundaryLoads).not.toHaveBeenCalled();
  });
});
