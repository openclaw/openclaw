import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const listChannelPairingRequests = vi.fn();
const approveChannelPairingCode = vi.fn();
const notifyPairingApproved = vi.fn();
const pairingIdLabels: Record<string, string> = {
  telegram: "telegramUserId",
  discord: "discordUserId",
};
const normalizeChannelId = vi.fn((raw: string) => {
  if (!raw) {
    return null;
  }
  if (raw === "imsg") {
    return "imessage";
  }
  if (["telegram", "discord", "imessage"].includes(raw)) {
    return raw;
  }
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
  let registerPairingCli: typeof import("./pairing-cli.js").registerPairingCli;

  beforeAll(async () => {
    ({ registerPairingCli } = await import("./pairing-cli.js"));
  });

  beforeEach(() => {
    listChannelPairingRequests.mockReset();
    approveChannelPairingCode.mockReset();
    notifyPairingApproved.mockReset();
    normalizeChannelId.mockClear();
    getPairingAdapter.mockClear();
    listPairingChannels.mockClear();
  });

  function createProgram() {
    const program = new Command();
    program.name("test");
    registerPairingCli(program);
    return program;
  }

  async function runPairing(args: string[]) {
    const program = createProgram();
    await program.parseAsync(args, { from: "user" });
  }

  function mockApprovedPairing() {
    approveChannelPairingCode.mockResolvedValueOnce({
      id: "123",
      entry: {
        id: "123",
        code: "ABCDEFGH",
        createdAt: "2026-01-08T00:00:00Z",
        lastSeenAt: "2026-01-08T00:00:00Z",
      },
    });
  }

  it("evaluates pairing channels when registering the CLI (not at import)", async () => {
    expect(listPairingChannels).not.toHaveBeenCalled();

    createProgram();

    expect(listPairingChannels).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "telegram ids",
      channel: "telegram",
      id: "123",
      label: "telegramUserId",
      meta: { username: "peter" },
    },
    {
      name: "discord ids",
      channel: "discord",
      id: "999",
      label: "discordUserId",
      meta: { tag: "Ada#0001" },
    },
  ])("labels $name correctly", async ({ channel, id, label, meta }) => {
    listChannelPairingRequests.mockResolvedValueOnce([
      {
        id,
        code: "ABC123",
        createdAt: "2026-01-08T00:00:00Z",
        lastSeenAt: "2026-01-08T00:00:00Z",
        meta,
      },
    ]);

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runPairing(["pairing", "list", "--channel", channel]);
      const output = log.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(output).toContain(label);
      expect(output).toContain(id);
    } finally {
      log.mockRestore();
    }
  });

  it("accepts channel as positional for list", async () => {
    listChannelPairingRequests.mockResolvedValueOnce([]);

    await runPairing(["pairing", "list", "telegram"]);

    expect(listChannelPairingRequests).toHaveBeenCalledWith("telegram");
  });

  it("forwards --account for list", async () => {
    listChannelPairingRequests.mockResolvedValueOnce([]);

    await runPairing(["pairing", "list", "--channel", "telegram", "--account", "yy"]);

    expect(listChannelPairingRequests).toHaveBeenCalledWith("telegram", process.env, "yy");
  });

  it("normalizes channel aliases", async () => {
    listChannelPairingRequests.mockResolvedValueOnce([]);

    await runPairing(["pairing", "list", "imsg"]);

    expect(normalizeChannelId).toHaveBeenCalledWith("imsg");
    expect(listChannelPairingRequests).toHaveBeenCalledWith("imessage");
  });

  it("accepts extension channels outside the registry", async () => {
    listChannelPairingRequests.mockResolvedValueOnce([]);

    await runPairing(["pairing", "list", "zalo"]);

    expect(normalizeChannelId).toHaveBeenCalledWith("zalo");
    expect(listChannelPairingRequests).toHaveBeenCalledWith("zalo");
  });

  it("accepts channel as positional for approve (npm-run compatible)", async () => {
    mockApprovedPairing();

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runPairing(["pairing", "approve", "telegram", "ABCDEFGH"]);

      expect(approveChannelPairingCode).toHaveBeenCalledWith({
        channel: "telegram",
        code: "ABCDEFGH",
      });
      expect(log).toHaveBeenCalledWith(expect.stringContaining("Approved"));
    } finally {
      log.mockRestore();
    }
  });

  it("forwards --account for approve", async () => {
    mockApprovedPairing();

    await runPairing([
      "pairing",
      "approve",
      "--channel",
      "telegram",
      "--account",
      "yy",
      "ABCDEFGH",
    ]);

    expect(approveChannelPairingCode).toHaveBeenCalledWith({
      channel: "telegram",
      code: "ABCDEFGH",
      accountId: "yy",
    });
  });
});
