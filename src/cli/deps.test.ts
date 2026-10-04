// Dependency tests cover CLI dependency imports and cold-start safety.
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { createOutboundSendDeps } from "./outbound-send-deps.js";

const mocks = vi.hoisted(() => ({
  runtimeLoaded: vi.fn(),
  sendMessage: vi.fn(async () => ({ messageId: "sent" })),
}));

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: () =>
    ["whatsapp", "telegram", "discord", "slack", "signal", "imessage"].map(
      (id) =>
        ({
          id,
          meta: { label: id, selectionLabel: id, docsPath: `/channels/${id}`, blurb: "" },
        }) as ChannelPlugin,
    ),
}));

vi.mock("./send-runtime/channel-outbound-send.js", () => {
  mocks.runtimeLoaded();
  return { sendChannelOutboundMessage: mocks.sendMessage };
});

describe("createDefaultDeps", () => {
  async function loadCreateDefaultDeps(scope: string) {
    return (
      await importFreshModule<typeof import("./deps.js")>(
        import.meta.url,
        `./deps.js?scope=${scope}`,
      )
    ).createDefaultDeps;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads the send runtime only when used and routes each call to its channel", async () => {
    const createDefaultDeps = await loadCreateDefaultDeps("lazy-load");
    const deps = createDefaultDeps();
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
    const createDefaultDeps = await loadCreateDefaultDeps("discord-voice-helper");
    const deps = createDefaultDeps();

    expect(deps.discordVoice).toBeUndefined();
    expect(deps.sendDiscordVoice).toBeUndefined();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("does not expose lazy channel senders as low-level outbound transports", async () => {
    const createDefaultDeps = await loadCreateDefaultDeps("outbound-transport-boundary");
    const deps = createDefaultDeps();

    const sendTelegram = deps.telegram as (...args: unknown[]) => Promise<unknown>;
    await sendTelegram("chat", "hello", { verbose: false });

    const outbound = createOutboundSendDeps(deps);
    expect(outbound.telegram).toBeUndefined();
    expect(outbound.sendTelegram).toBeUndefined();
    expect(mocks.sendMessage).toHaveBeenCalledOnce();
  });

  it("allows another send after a transient channel failure", async () => {
    mocks.sendMessage.mockRejectedValueOnce(new Error("transient channel failure"));
    const createDefaultDeps = await loadCreateDefaultDeps("send-retry");
    const deps = createDefaultDeps();
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
