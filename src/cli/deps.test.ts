import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "./deps.js";
import { createOutboundSendDeps } from "./outbound-send-deps.js";

const mocks = vi.hoisted(() => ({
  runtimeLoaded: vi.fn(),
  sendMessage: vi.fn(async () => ({ messageId: "sent" })),
}));

vi.mock("./send-runtime/channel-outbound-send.js", async (importOriginal) => {
  mocks.runtimeLoaded();
  return {
    ...(await importOriginal<typeof import("./send-runtime/channel-outbound-send.js")>()),
    sendChannelOutboundMessage: mocks.sendMessage,
  };
});

describe("createDefaultDeps", () => {
  let deps: CliDeps;
  beforeEach(async ({ task }) => {
    vi.clearAllMocks();
    deps = (
      await importFreshModule<typeof import("./deps.js")>(
        import.meta.url,
        `./deps.js?scope=${task.id}`,
      )
    ).createDefaultDeps();
  });

  it("loads the send runtime only when used and routes each call to its channel", async () => {
    const sendTelegram = deps.telegram as (...args: unknown[]) => Promise<unknown>;
    const sendDiscord = deps.discord as (...args: unknown[]) => Promise<unknown>;

    expect(mocks.runtimeLoaded).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();

    await sendTelegram("chat", "hello", { verbose: false });
    await sendDiscord("channel", "first", { verbose: false });
    await sendDiscord("channel", "second", { verbose: false });

    expect(mocks.runtimeLoaded).toHaveBeenCalledOnce();
    expect(mocks.sendMessage.mock.calls).toEqual([
      ["telegram", "chat", "hello", { verbose: false }],
      ["discord", "channel", "first", { verbose: false }],
      ["discord", "channel", "second", { verbose: false }],
    ]);
  });

  it("does not create channel senders for Discord voice helper keys", async () => {
    expect([deps.discordVoice, deps.sendDiscordVoice]).toEqual([undefined, undefined]);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("does not expose lazy channel senders as low-level outbound transports", async () => {
    const sendTelegram = deps.telegram as (...args: unknown[]) => Promise<unknown>;
    await sendTelegram("chat", "hello", { verbose: false });

    const outbound = createOutboundSendDeps(deps);
    expect([outbound.telegram, outbound.sendTelegram]).toEqual([undefined, undefined]);
    expect(mocks.sendMessage).toHaveBeenCalledOnce();
  });

  it("allows another send after a transient channel failure", async () => {
    mocks.sendMessage.mockRejectedValueOnce(new Error("transient channel failure"));
    const sendTelegram = deps.telegram as (...args: unknown[]) => Promise<unknown>;

    await expect(sendTelegram("chat", "first", { verbose: false })).rejects.toThrow(
      "transient channel failure",
    );
    await expect(sendTelegram("chat", "second", { verbose: false })).resolves.toEqual({
      messageId: "sent",
    });

    expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
  });
});
