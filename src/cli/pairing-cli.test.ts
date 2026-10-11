// Pairing CLI tests cover pairing command registration and pairing status output.
import { expectDefined } from "@openclaw/normalization-core";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { theme } from "../../packages/terminal-core/src/theme.js";
import type { runWithLocalStateOwner } from "./local-state-owner.js";
import { registerPairingCli } from "./pairing-cli.js";

const mocks = vi.hoisted(() => ({
  runWithLocalStateOwner: vi.fn<typeof runWithLocalStateOwner>(),
  listChannelPairingRequests: vi.fn(),
  approveChannelPairingCode: vi.fn(),
  notifyPairingApproved: vi.fn(),
  readConfigFileSnapshotForWrite: vi.fn(),
  replaceConfigFile: vi.fn(),
  normalizeChannelId: vi.fn((raw: string) => {
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
  }),
  getPairingAdapter: vi.fn((channel: string) => ({
    idLabel: pairingIdLabels[channel] ?? "userId",
  })),
  listPairingChannels: vi.fn(() => ["telegram", "discord", "imessage"]),
}));

const {
  listChannelPairingRequests,
  approveChannelPairingCode,
  notifyPairingApproved,
  readConfigFileSnapshotForWrite,
  replaceConfigFile,
  normalizeChannelId,
  getPairingAdapter,
  listPairingChannels,
} = mocks;

const pairingIdLabels: Record<string, string> = {
  telegram: "telegramUserId",
  discord: "discordUserId",
};

vi.mock("../pairing/pairing-store.js", () => ({
  listChannelPairingRequests: mocks.listChannelPairingRequests,
  approveChannelPairingCode: mocks.approveChannelPairingCode,
}));

vi.mock("./local-state-owner.js", () => ({
  runWithLocalStateOwner: mocks.runWithLocalStateOwner,
}));

vi.mock("../channels/plugins/pairing.js", () => ({
  listPairingChannels: mocks.listPairingChannels,
  notifyPairingApproved: mocks.notifyPairingApproved,
  getPairingAdapter: mocks.getPairingAdapter,
}));

vi.mock("../channels/plugins/index.js", () => ({
  normalizeChannelId: mocks.normalizeChannelId,
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: vi.fn().mockReturnValue({}),
  loadConfig: vi.fn().mockReturnValue({}),
  readConfigFileSnapshotForWrite: mocks.readConfigFileSnapshotForWrite,
  replaceConfigFile: mocks.replaceConfigFile,
}));

describe("pairing cli", () => {
  beforeEach(() => {
    mocks.runWithLocalStateOwner.mockReset().mockImplementation(async ({ runLocal }) =>
      runLocal({
        env: process.env,
        config: {},
        signal: new AbortController().signal,
        assertCurrent() {},
      }),
    );
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
    readConfigFileSnapshotForWrite.mockClear();
    readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: {
        path: "/tmp/openclaw.json",
        exists: true,
        raw: "{}",
        parsed: {},
        valid: true,
        issues: [],
        legacyIssues: [],
        sourceConfig: {},
        runtimeConfig: {},
      },
      writeOptions: {},
    });
    replaceConfigFile.mockClear();
    replaceConfigFile.mockResolvedValue(undefined);
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

  it("labels sender ids using the channel's pairing adapter", async () => {
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
    try {
      await runPairing(["pairing", "list", "--channel", "telegram"]);
      const output = log.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(output).toContain("telegramUserId");
      expect(output).toContain("123");
    } finally {
      log.mockRestore();
    }
  });

  it("rejects conflicting positional and option channels for list", async () => {
    await expect(
      runPairing(["pairing", "list", "discord", "--channel", "telegram"]),
    ).rejects.toThrow(
      'Conflicting pairing channels: "telegram" and "discord". Pass the channel either positionally or with --channel.',
    );

    expect(listChannelPairingRequests).not.toHaveBeenCalled();
  });

  it("forwards --account for list", async () => {
    listChannelPairingRequests.mockResolvedValueOnce([]);

    await runPairing(["pairing", "list", "--channel", "telegram", "--account", "yy"]);

    expect(listChannelPairingRequests).toHaveBeenCalledWith(
      "telegram",
      process.env,
      "yy",
      expect.any(Function),
    );
  });

  it("defaults list to the sole available channel", async () => {
    listPairingChannels.mockReturnValueOnce(["slack"]);
    listChannelPairingRequests.mockResolvedValueOnce([]);

    await runPairing(["pairing", "list"]);

    expect(listChannelPairingRequests).toHaveBeenCalledWith(
      "slack",
      process.env,
      undefined,
      expect.any(Function),
    );
  });

  it("redirects to openclaw devices when no pairing channels are configured", async () => {
    listPairingChannels.mockReturnValueOnce([]);

    const error = await runPairing(["pairing", "list"]).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("openclaw devices");
    // Must not leak the empty enum that originally read like a bug.
    expect(message).not.toContain("expected one of: )");
    expect(message).not.toContain("()");
    expect(listChannelPairingRequests).not.toHaveBeenCalled();
  });

  it("lists supported channels when one is required but omitted", async () => {
    // Multiple channels configured (default mock) + no channel argument.
    await expect(runPairing(["pairing", "list"])).rejects.toThrow(
      "expected one of: telegram, discord, imessage",
    );
  });

  it("accepts channel as positional for approve (npm-run compatible)", async () => {
    mockApprovedPairing();

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runPairing(["pairing", "approve", "telegram", "ABCDEFGH"]);

      expect(approveChannelPairingCode).toHaveBeenCalledWith({
        channel: "telegram",
        code: "ABCDEFGH",
        env: process.env,
        assertCurrent: expect.any(Function),
      });
      const replaceCall = expectDefined<unknown[]>(
        replaceConfigFile.mock.calls.at(0),
        "config replace",
      )[0] as { sourceConfig?: { commands?: { ownerAllowFrom?: string[] } } } | undefined;
      expect(replaceCall?.sourceConfig?.commands?.ownerAllowFrom).toEqual(["telegram:123"]);
      expect(log.mock.calls).toEqual([
        [`${theme.success("Approved")} ${theme.muted("telegram")} sender ${theme.command("123")}.`],
        [
          `${theme.success("Command owner configured")} ${theme.command("telegram:123")} ${theme.muted("(commands.ownerAllowFrom was empty).")}`,
        ],
      ]);
    } finally {
      log.mockRestore();
    }
  });

  it("does not overwrite an existing command owner when approving pairing", async () => {
    readConfigFileSnapshotForWrite.mockResolvedValueOnce({
      snapshot: {
        path: "/tmp/openclaw.json",
        exists: true,
        raw: "{}",
        parsed: {},
        valid: true,
        issues: [],
        legacyIssues: [],
        sourceConfig: { commands: { ownerAllowFrom: ["discord:999"] } },
        runtimeConfig: { commands: { ownerAllowFrom: ["discord:999"] } },
      },
      writeOptions: {},
    });
    mockApprovedPairing();

    await runPairing(["pairing", "approve", "telegram", "ABCDEFGH"]);

    expect(replaceConfigFile).not.toHaveBeenCalled();
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
      env: process.env,
      assertCurrent: expect.any(Function),
    });
  });

  it("rejects a whitespace-only --account for approve", async () => {
    await expect(
      runPairing(["pairing", "approve", "--channel", "telegram", "--account", "   ", "ABCDEFGH"]),
    ).rejects.toThrow("--account must not be blank");

    expect(approveChannelPairingCode).not.toHaveBeenCalled();
    expect(readConfigFileSnapshotForWrite).not.toHaveBeenCalled();
    expect(replaceConfigFile).not.toHaveBeenCalled();
  });

  it("defaults approve to the sole available channel when only code is provided", async () => {
    listPairingChannels.mockReturnValueOnce(["slack"]);
    mockApprovedPairing();

    await runPairing(["pairing", "approve", "ABCDEFGH"]);

    expect(approveChannelPairingCode).toHaveBeenCalledWith({
      channel: "slack",
      code: "ABCDEFGH",
      env: process.env,
      assertCurrent: expect.any(Function),
    });
  });

  it("keeps approve usage error when multiple channels exist and channel is omitted", async () => {
    await expect(runPairing(["pairing", "approve", "ABCDEFGH"])).rejects.toThrow("Usage:");
  });

  it.each(["OUTCOME_UNKNOWN"])(
    "does not bootstrap, notify, or approve locally after %s",
    async (reason) => {
      mocks.runWithLocalStateOwner.mockRejectedValueOnce(new Error(reason));

      await expect(
        runPairing(["pairing", "approve", "telegram", "ABCDEFGH", "--notify"]),
      ).rejects.toThrow(reason);

      expect(approveChannelPairingCode).not.toHaveBeenCalled();
      expect(replaceConfigFile).not.toHaveBeenCalled();
      expect(notifyPairingApproved).not.toHaveBeenCalled();
    },
  );
});
