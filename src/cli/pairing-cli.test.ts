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
  generateQrCode:
    channel === "deltachat"
      ? vi.fn().mockResolvedValue({
          ok: true,
          qrCodeData: "https://test.example.com/qr",
          qrCodeImage: "[QR code ASCII]",
        })
      : undefined,
}));
const listPairingChannels = vi.fn(() => ["telegram", "discord", "imessage", "deltachat"]);

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
    listChannelPairingRequests.mockClear();
    listChannelPairingRequests.mockResolvedValue([]);
    approveChannelPairingCode.mockClear();
    approveChannelPairingCode.mockResolvedValue({
      id: "123",
      entry: {
        id: "123",
        code: "ABCDEFGH",
        createdAt: "2026-01-08T00:00:00Z",
        lastSeenAt: "2026-01-08T00:00:00Z",
      },
    });
    notifyPairingApproved.mockClear();
    normalizeChannelId.mockClear();
    getPairingAdapter.mockClear();
    listPairingChannels.mockClear();
    notifyPairingApproved.mockResolvedValue(undefined);
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

  it("defaults list to the sole available channel", async () => {
    listPairingChannels.mockReturnValueOnce(["slack"]);
    listChannelPairingRequests.mockResolvedValueOnce([]);

    await runPairing(["pairing", "list"]);

    expect(listChannelPairingRequests).toHaveBeenCalledWith("slack");
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

  it("generates QR code for deltachat with default options", async () => {
    const _log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runPairing(["pairing", "generate"]);
      const output = _log.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(output).toContain("[QR code ASCII]");
      expect(output).toContain("https://test.example.com/qr");
    } finally {
      _log.mockRestore();
    }
  });

  it("generates QR code for deltachat with file output", async () => {
    getPairingAdapter.mockClear();
    await runPairing(["pairing", "generate", "--output", "/tmp/qr.txt"]);
    expect(getPairingAdapter).toHaveBeenCalledWith("deltachat");
  });

  it("throws error when channel does not support QR generation", async () => {
    getPairingAdapter.mockReturnValueOnce({ idLabel: "userId", generateQrCode: undefined }); // No generateQrCode method

    await expect(runPairing(["pairing", "generate", "--channel", "telegram"])).rejects.toThrow(
      "Channel telegram does not support QR code generation",
    );
  });

  it("accepts --channel and --code options for approve", async () => {
    approveChannelPairingCode.mockResolvedValueOnce({
      id: "456",
      entry: {
        id: "456",
        code: "5NQ7DX6G",
        createdAt: "2026-01-08T00:00:00Z",
        lastSeenAt: "2026-01-08T00:00:00Z",
      },
    });

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runPairing(["pairing", "approve", "--channel", "deltachat", "--code", "5NQ7DX6G"]);

      expect(approveChannelPairingCode).toHaveBeenCalledWith({
        channel: "deltachat",
        code: "5NQ7DX6G",
      });
      expect(log).toHaveBeenCalledWith(expect.stringContaining("Approved"));
    } finally {
      log.mockRestore();
    }
  });

  it("accepts --channel with positional code for approve", async () => {
    approveChannelPairingCode.mockResolvedValueOnce({
      id: "789",
      entry: {
        id: "789",
        code: "XYZ999",
        createdAt: "2026-01-08T00:00:00Z",
        lastSeenAt: "2026-01-08T00:00:00Z",
      },
    });

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runPairing(["pairing", "approve", "--channel", "telegram", "XYZ999"]);

      expect(approveChannelPairingCode).toHaveBeenCalledWith({
        channel: "telegram",
        code: "XYZ999",
      });
      expect(log).toHaveBeenCalledWith(expect.stringContaining("Approved"));
    } finally {
      log.mockRestore();
    }
  });

  it("throws error when --code is used without --channel", async () => {
    await expect(runPairing(["pairing", "approve", "--code", "5NQ7DX6G"])).rejects.toThrow(
      "Channel required",
    );
  });
});
