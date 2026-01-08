import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

const listProviderPairingRequests = vi.fn();

vi.mock("../pairing/pairing-store.js", () => ({
  listProviderPairingRequests,
  approveProviderPairingCode: vi.fn(),
}));

vi.mock("../telegram/send.js", () => ({
  sendMessageTelegram: vi.fn(),
}));

vi.mock("../discord/send.js", () => ({
  sendMessageDiscord: vi.fn(),
}));

vi.mock("../slack/send.js", () => ({
  sendMessageSlack: vi.fn(),
}));

vi.mock("../signal/send.js", () => ({
  sendMessageSignal: vi.fn(),
}));

vi.mock("../imessage/send.js", () => ({
  sendMessageIMessage: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn().mockReturnValue({}),
}));

vi.mock("../telegram/token.js", () => ({
  resolveTelegramToken: vi.fn().mockReturnValue({ token: "t" }),
}));

describe("pairing cli", () => {
  it("labels Telegram ids as telegramUserId", async () => {
    const { registerPairingCli } = await import("./pairing-cli.js");
    listProviderPairingRequests.mockResolvedValueOnce([
      {
        id: "123",
        code: "ABC123",
        createdAt: "2026-01-08T00:00:00Z",
        lastSeenAt: "2026-01-08T00:00:00Z",
        meta: { username: "peter" },
      },
    ]);

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    program.name("test");
    registerPairingCli(program);
    await program.parseAsync(["pairing", "list", "--provider", "telegram"], {
      from: "user",
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("telegramUserId=123"),
    );
  });
});

