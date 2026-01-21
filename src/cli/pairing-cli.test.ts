import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

const listChannelPairingRequests = vi.fn();
const approveChannelPairingCode = vi.fn();
const notifyPairingApproved = vi.fn();
const pairingIdLabels: Record<string, string> = {
  telegram: "telegramUserId",
  discord: "discordUserId",
};
const normalizeChannelId = vi.fn((raw: string) => {
  if (!raw) return null;
  if (raw === "imsg") return "imessage";
  if (["telegram", "discord", "imessage"].includes(raw)) return raw;
  return null;
});
const getPairingAdapter = vi.fn((channel: string) => ({
  idLabel: pairingIdLabels[channel] ?? "userId",
}));
const listPairingChannels = vi.fn(() => ["telegram", "discord", "imessage"]);

vi.mock("../pairing/pairing-store.js", () => ({
  listChannelPairingRequests,
  approveChannelPairingCode,
}));

vi.mock("../channels/plugins/pairing.js", () => ({
  listPairingChannels,
  notifyPairingApproved,
  getPairingAdapter,
}));

vi.mock("../channels/plugins/index.js", () => ({
  normalizeChannelId,
}));

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn().mockReturnValue({}),
}));

describe("pairing cli", () => {
  it("evaluates pairing channels when registering the CLI (not at import)", async () => {
    listPairingChannels.mockClear();

    const { registerPairingCli } = await import("./pairing-cli.js");
    expect(listPairingChannels).not.toHaveBeenCalled();

    const program = new Command();
    program.name("test");
    registerPairingCli(program);

    expect(listPairingChannels).toHaveBeenCalledTimes(1);
  });

  it("labels Telegram ids as telegramUserId", async () => {
    const { registerPairingCli } = await import("./pairing-cli.js");
    listChannelPairingRequests.mockResolvedValueOnce([
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
    await program.parseAsync(["pairing", "list", "--channel", "telegram"], {
      from: "user",
    });
    const output = log.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("telegramUserId");
    expect(output).toContain("123");
  });

  it("accepts channel as positional for list", async () => {
    const { registerPairingCli } = await import("./pairing-cli.js");
    listChannelPairingRequests.mockResolvedValueOnce([]);

    const program = new Command();
    program.name("test");
    registerPairingCli(program);
    await program.parseAsync(["pairing", "list", "telegram"], { from: "user" });

    expect(listChannelPairingRequests).toHaveBeenCalledWith("telegram");
  });

  it("normalizes channel aliases", async () => {
    const { registerPairingCli } = await import("./pairing-cli.js");
    listChannelPairingRequests.mockResolvedValueOnce([]);

    const program = new Command();
    program.name("test");
    registerPairingCli(program);
    await program.parseAsync(["pairing", "list", "imsg"], { from: "user" });

    expect(normalizeChannelId).toHaveBeenCalledWith("imsg");
    expect(listChannelPairingRequests).toHaveBeenCalledWith("imessage");
  });

  it("accepts extension channels outside the registry", async () => {
    const { registerPairingCli } = await import("./pairing-cli.js");
    listChannelPairingRequests.mockResolvedValueOnce([]);

    const program = new Command();
    program.name("test");
    registerPairingCli(program);
    await program.parseAsync(["pairing", "list", "zalo"], { from: "user" });

    expect(normalizeChannelId).toHaveBeenCalledWith("zalo");
    expect(listChannelPairingRequests).toHaveBeenCalledWith("zalo");
  });

  it("labels Discord ids as discordUserId", async () => {
    const { registerPairingCli } = await import("./pairing-cli.js");
    listChannelPairingRequests.mockResolvedValueOnce([
      {
        id: "999",
        code: "DEF456",
        createdAt: "2026-01-08T00:00:00Z",
        lastSeenAt: "2026-01-08T00:00:00Z",
        meta: { tag: "Ada#0001" },
      },
    ]);

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    program.name("test");
    registerPairingCli(program);
    await program.parseAsync(["pairing", "list", "--channel", "discord"], {
      from: "user",
    });
    const output = log.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("discordUserId");
    expect(output).toContain("999");
  });

  it("accepts channel as positional for approve (npm-run compatible)", async () => {
    const { registerPairingCli } = await import("./pairing-cli.js");
    approveChannelPairingCode.mockResolvedValueOnce({
      id: "123",
      entry: {
        id: "123",
        code: "ABCDEFGH",
        createdAt: "2026-01-08T00:00:00Z",
        lastSeenAt: "2026-01-08T00:00:00Z",
      },
    });

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    program.name("test");
    registerPairingCli(program);
    await program.parseAsync(["pairing", "approve", "telegram", "ABCDEFGH"], {
      from: "user",
    });

    expect(approveChannelPairingCode).toHaveBeenCalledWith({
      channel: "telegram",
      code: "ABCDEFGH",
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Approved"));
  });
});
