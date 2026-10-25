import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestConfigSnapshot } from "../commands/test-runtime-config-helpers.js";
import type { runWithLocalStateOwner } from "./local-state-owner.js";
import { registerPairingCli } from "./pairing-cli.js";

const mocks = vi.hoisted(() => ({
  runWithLocalStateOwner: vi.fn<typeof runWithLocalStateOwner>(),
  listChannelPairingRequests: vi.fn(),
  approveChannelPairingCode: vi.fn(),
  notifyPairingApproved: vi.fn(),
  readConfigFileSnapshotForWrite: vi.fn(),
  replaceConfigFile: vi.fn(),
  normalizeChannelId: vi.fn((raw: string) =>
    ["telegram", "discord", "imessage"].includes(raw) ? raw : null,
  ),
  getPairingAdapter: vi.fn((channel: string) => ({
    idLabel:
      channel === "telegram"
        ? "telegramUserId"
        : channel === "discord"
          ? "discordUserId"
          : "userId",
  })),
  listPairingChannels: vi.fn(() => ["telegram", "discord", "imessage"]),
}));
const request = {
  id: "123",
  code: "ABCDEFGH",
  createdAt: "2026-01-08T00:00:00Z",
  lastSeenAt: "2026-01-08T00:00:00Z",
};
const configSnapshot = (ownerAllowFrom?: string[]) => ({
  snapshot: createTestConfigSnapshot(ownerAllowFrom ? { commands: { ownerAllowFrom } } : {}),
  writeOptions: {},
});
vi.mock("../pairing/pairing-store.js", () => ({
  listChannelPairingRequests: mocks.listChannelPairingRequests,
  approveChannelPairingCode: mocks.approveChannelPairingCode,
}));
vi.mock("./local-state-owner.js", () => ({ runWithLocalStateOwner: mocks.runWithLocalStateOwner }));
vi.mock("../channels/plugins/pairing.js", () => ({
  listPairingChannels: mocks.listPairingChannels,
  notifyPairingApproved: mocks.notifyPairingApproved,
  getPairingAdapter: mocks.getPairingAdapter,
}));
vi.mock("../channels/plugins/index.js", () => ({ normalizeChannelId: mocks.normalizeChannelId }));
// mock-isolation: Pairing fixtures own empty config and intercepted writes.
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: vi.fn().mockReturnValue({}),
  loadConfig: vi.fn().mockReturnValue({}),
  captureRuntimeConfigAsyncReader: () => async () => ({}),
  readConfigFileSnapshotForWrite: mocks.readConfigFileSnapshotForWrite,
  replaceConfigFile: mocks.replaceConfigFile,
}));

afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  vi.clearAllMocks();
  mocks.runWithLocalStateOwner.mockReset().mockImplementation(async ({ runLocal }) =>
    runLocal({
      env: process.env,
      config: {},
      signal: new AbortController().signal,
      assertCurrent() {},
    }),
  );
  mocks.listChannelPairingRequests.mockResolvedValue([]);
  mocks.approveChannelPairingCode.mockResolvedValue({ id: "123", entry: request });
  mocks.readConfigFileSnapshotForWrite.mockResolvedValue(configSnapshot());
  mocks.replaceConfigFile.mockResolvedValue(undefined);
  mocks.notifyPairingApproved.mockResolvedValue(undefined);
});

async function run(args: string | string[]) {
  const program = new Command().name("test");
  registerPairingCli(program);
  await program.parseAsync(["pairing", ...(typeof args === "string" ? args.split(" ") : args)], {
    from: "user",
  });
}
function expectNoApproval() {
  for (const effect of [
    mocks.approveChannelPairingCode,
    mocks.readConfigFileSnapshotForWrite,
    mocks.replaceConfigFile,
    mocks.notifyPairingApproved,
  ]) {
    expect(effect).not.toHaveBeenCalled();
  }
}

it.each([
  [["telegram", "discord"], "list --channel telegram --account yy", "yy"],
  [["slack"], "list", undefined],
] as const)("lists requests for %j", async (channels, args, account) => {
  mocks.listPairingChannels.mockReturnValueOnce([...channels]);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  if (account) {
    mocks.listChannelPairingRequests.mockResolvedValueOnce([
      { ...request, meta: { username: "peter" } },
    ]);
  }
  await run(args);
  expect(mocks.listChannelPairingRequests).toHaveBeenCalledWith(
    channels[0],
    process.env,
    account,
    expect.any(Function),
  );
  if (account) {
    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("telegramUserId");
    expect(output).toContain("123");
  }
});

it.each<[string | string[], string, string[]?]>([
  ["list discord --channel telegram", 'Conflicting pairing channels: "telegram" and "discord".'],
  ["list", "openclaw devices", []],
  ["list", "expected one of: telegram, discord, imessage"],
  ["approve ABCDEFGH", "Usage:"],
  [
    ["approve", "--channel", "telegram", "--account", "   ", "ABCDEFGH"],
    "--account must not be blank",
  ],
])("rejects %j: %s", async (args, error, channels) => {
  if (channels) {
    mocks.listPairingChannels.mockReturnValueOnce(channels);
  }
  const result = run(args);
  await expect(result).rejects.toThrow(error);
  if (channels?.length === 0) {
    await expect(result).rejects.not.toThrow(/expected one of: \)|\(\)/);
  }
  expect(mocks.listChannelPairingRequests).not.toHaveBeenCalled();
  expectNoApproval();
});

it.each<[string, string, string?, string[]?]>([
  ["telegram ABCDEFGH", "telegram"],
  ["--channel telegram --account yy ABCDEFGH", "telegram", "yy"],
  ["ABCDEFGH", "slack"],
  ["telegram ABCDEFGH", "telegram", undefined, ["discord:999"]],
])("approves %s preserving the command owner", async (args, channel, account, owner) => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  if (channel === "slack") {
    mocks.listPairingChannels.mockReturnValueOnce([channel]);
  }
  mocks.readConfigFileSnapshotForWrite.mockResolvedValueOnce(configSnapshot(owner));
  await run(`approve ${args}`);
  expect(mocks.approveChannelPairingCode).toHaveBeenCalledWith({
    channel,
    code: "ABCDEFGH",
    ...(account ? { accountId: account } : {}),
    env: process.env,
    assertCurrent: expect.any(Function),
  });
  if (owner) {
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  } else if (channel === "telegram" && !account) {
    expect(mocks.replaceConfigFile.mock.calls[0]?.[0]).toMatchObject({
      sourceConfig: { commands: { ownerAllowFrom: ["telegram:123"] } },
    });
    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("Approved");
    expect(output).toContain("123");
    expect(output).toContain("Command owner configured");
    expect(output).toContain("telegram:123");
  }
});

it("does not bootstrap, notify, or approve locally after OUTCOME_UNKNOWN", async () => {
  mocks.runWithLocalStateOwner.mockRejectedValueOnce(new Error("OUTCOME_UNKNOWN"));
  await expect(run("approve telegram ABCDEFGH --notify")).rejects.toThrow("OUTCOME_UNKNOWN");
  expectNoApproval();
});
