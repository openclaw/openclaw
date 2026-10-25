import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { theme } from "../../packages/terminal-core/src/theme.js";
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
  listPairingChannels,
} = mocks;

const pairingIdLabels: Record<string, string> = {
  telegram: "telegramUserId",
  discord: "discordUserId",
};
const pairingRequest = {
  id: "123",
  code: "ABCDEFGH",
  createdAt: "2026-01-08T00:00:00Z",
  lastSeenAt: "2026-01-08T00:00:00Z",
};

function configSnapshot(ownerAllowFrom?: string[]) {
  const config = ownerAllowFrom ? { commands: { ownerAllowFrom } } : {};
  return { snapshot: createTestConfigSnapshot(config), writeOptions: {} };
}

function expectApproval(channel = "telegram", account = {}) {
  expect(approveChannelPairingCode).toHaveBeenCalledWith({
    channel,
    code: "ABCDEFGH",
    ...account,
    env: process.env,
    assertCurrent: expect.any(Function),
  });
}

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

// mock-isolation: Pairing command fixtures own empty config and intercepted config writes.
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
  listChannelPairingRequests.mockResolvedValue([]);
  approveChannelPairingCode.mockResolvedValue({ id: "123", entry: pairingRequest });
  readConfigFileSnapshotForWrite.mockResolvedValue(configSnapshot());
  replaceConfigFile.mockResolvedValue(undefined);
  notifyPairingApproved.mockResolvedValue(undefined);
});

async function runPairing(command: "list" | "approve", ...args: string[]) {
  const program = new Command();
  program.name("test");
  registerPairingCli(program);
  await program.parseAsync(["pairing", command, ...args], { from: "user" });
}

it("lists account-scoped requests with the channel's sender label", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  listChannelPairingRequests.mockResolvedValueOnce([
    { ...pairingRequest, code: "ABC123", meta: { username: "peter" } },
  ]);

  await runPairing("list", "--channel", "telegram", "--account", "yy");
  const output = log.mock.calls.map((call) => call.join(" ")).join("\n");
  expect(output).toContain("telegramUserId");
  expect(output).toContain("123");
  expect(listChannelPairingRequests).toHaveBeenCalledWith(
    "telegram",
    process.env,
    "yy",
    expect.any(Function),
  );
});

it("rejects conflicting positional and option channels for list", async () => {
  await expect(runPairing("list", "discord", "--channel", "telegram")).rejects.toThrow(
    'Conflicting pairing channels: "telegram" and "discord". Pass the channel either positionally or with --channel.',
  );

  expect(listChannelPairingRequests).not.toHaveBeenCalled();
});

it("defaults list to the sole available channel", async () => {
  listPairingChannels.mockReturnValueOnce(["slack"]);
  await runPairing("list");

  expect(listChannelPairingRequests).toHaveBeenCalledWith(
    "slack",
    process.env,
    undefined,
    expect.any(Function),
  );
});

it("redirects to openclaw devices when no pairing channels are configured", async () => {
  listPairingChannels.mockReturnValueOnce([]);

  const listing = runPairing("list");
  await expect(listing).rejects.toThrow("openclaw devices");
  await expect(listing).rejects.not.toThrow(/expected one of: \)|\(\)/);
  expect(listChannelPairingRequests).not.toHaveBeenCalled();
});

it("lists supported channels when one is required but omitted", async () => {
  await expect(runPairing("list")).rejects.toThrow("expected one of: telegram, discord, imessage");
});

it("accepts channel as positional for approve (npm-run compatible)", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await runPairing("approve", "telegram", "ABCDEFGH");

  expectApproval();
  expect(replaceConfigFile.mock.calls[0]?.[0]).toMatchObject({
    sourceConfig: { commands: { ownerAllowFrom: ["telegram:123"] } },
  });
  expect(log.mock.calls).toEqual([
    [`${theme.success("Approved")} ${theme.muted("telegram")} sender ${theme.command("123")}.`],
    [
      `${theme.success("Command owner configured")} ${theme.command("telegram:123")} ${theme.muted("(commands.ownerAllowFrom was empty).")}`,
    ],
  ]);
});

it("does not overwrite an existing command owner when approving pairing", async () => {
  readConfigFileSnapshotForWrite.mockResolvedValueOnce(configSnapshot(["discord:999"]));

  await runPairing("approve", "telegram", "ABCDEFGH");

  expect(replaceConfigFile).not.toHaveBeenCalled();
});

it.each([
  {
    name: "forwards --account",
    args: ["--channel", "telegram", "--account", "yy", "ABCDEFGH"],
    channel: "telegram",
    account: { accountId: "yy" },
  },
  { name: "defaults to the sole channel", args: ["ABCDEFGH"], channel: "slack", account: {} },
])("approve $name", async ({ args, channel, account }) => {
  if (channel === "slack") {
    listPairingChannels.mockReturnValueOnce([channel]);
  }
  await runPairing("approve", ...args);
  expectApproval(channel, account);
});

it("rejects a whitespace-only --account for approve", async () => {
  await expect(
    runPairing("approve", "--channel", "telegram", "--account", "   ", "ABCDEFGH"),
  ).rejects.toThrow("--account must not be blank");

  expect(approveChannelPairingCode).not.toHaveBeenCalled();
  expect(readConfigFileSnapshotForWrite).not.toHaveBeenCalled();
  expect(replaceConfigFile).not.toHaveBeenCalled();
});

it("keeps approve usage error when multiple channels exist and channel is omitted", async () => {
  await expect(runPairing("approve", "ABCDEFGH")).rejects.toThrow("Usage:");
});

it("does not bootstrap, notify, or approve locally after OUTCOME_UNKNOWN", async () => {
  const reason = "OUTCOME_UNKNOWN";
  mocks.runWithLocalStateOwner.mockRejectedValueOnce(new Error(reason));

  await expect(runPairing("approve", "telegram", "ABCDEFGH", "--notify")).rejects.toThrow(reason);

  expect(approveChannelPairingCode).not.toHaveBeenCalled();
  expect(replaceConfigFile).not.toHaveBeenCalled();
  expect(notifyPairingApproved).not.toHaveBeenCalled();
});
