import { Command } from "commander";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../../cli/gateway-rpc.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../cli/gateway-rpc.js")>();
  return {
    ...actual,
    callGatewayFromCliWithTransport: mocks.callGateway,
  };
});

vi.mock("../../runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../runtime.js")>();
  return {
    ...actual,
    defaultRuntime: mocks.runtime,
  };
});

import { registerChannelsCli } from "../../cli/channels-cli.js";
import { channelsReconnectCommand, channelsStartCommand } from "./start-stop.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.callGateway.mockResolvedValue({
    channel: "whatsapp",
    accountId: "work",
    started: true,
    outcome: { status: "handed-off" },
  });
});

async function parse(...args: string[]) {
  const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
  await registerChannelsCli(program, ["node", "openclaw", "channels", ...args], {
    includeSetupOptions: false,
  });
  await program.parseAsync(["channels", ...args], { from: "user" });
}

function loggedJson() {
  return JSON.parse(String(mocks.runtime.log.mock.calls[0]?.[0] ?? "{}"));
}

it("registers channels start and forwards --port through Gateway transport", async () => {
  await parse(
    "start",
    "--channel",
    "whatsapp",
    "--account",
    "work",
    "--port",
    "18794",
    "--token",
    "tok",
    "--timeout",
    "12000",
    "--json",
  );
  expect(mocks.callGateway).toHaveBeenCalledExactlyOnceWith(
    "channels.start",
    expect.objectContaining({
      port: "18794",
      token: "tok",
      timeout: "12000",
      json: true,
    }),
    { channel: "whatsapp", accountId: "work" },
    { defaultTimeoutMs: 60_000 },
  );
  expect(loggedJson()).toMatchObject({
    channel: "whatsapp",
    accountId: "work",
    started: true,
  });
});

it("registers channels stop and forwards --url targeting", async () => {
  mocks.callGateway.mockResolvedValue({
    channel: "telegram",
    accountId: "default",
    stopped: true,
  });
  await parse(
    "stop",
    "--channel",
    "telegram",
    "--url",
    "ws://127.0.0.1:18794",
    "--token",
    "tok",
    "--json",
  );
  expect(mocks.callGateway).toHaveBeenCalledExactlyOnceWith(
    "channels.stop",
    expect.objectContaining({
      url: "ws://127.0.0.1:18794",
      token: "tok",
      json: true,
    }),
    { channel: "telegram" },
    { defaultTimeoutMs: 60_000 },
  );
});

it("reconnect runs stop then start and prints both payloads", async () => {
  mocks.callGateway
    .mockResolvedValueOnce({ channel: "whatsapp", accountId: "work", stopped: true })
    .mockResolvedValueOnce({
      channel: "whatsapp",
      accountId: "work",
      started: true,
      outcome: { status: "handed-off" },
    });
  await channelsReconnectCommand(
    { channel: "whatsapp", account: "work", json: true },
    mocks.runtime as never,
  );
  expect(mocks.callGateway.mock.calls.map((call) => call[0])).toEqual([
    "channels.stop",
    "channels.start",
  ]);
  expect(loggedJson()).toMatchObject({
    stop: { stopped: true },
    start: { started: true, outcome: { status: "handed-off" } },
  });
});

it("rejects blank --account before any Gateway call", async () => {
  await expect(parse("start", "--channel", "whatsapp", "--account", "", "--json")).rejects.toThrow(
    /--account must not be blank/,
  );
  expect(mocks.callGateway).not.toHaveBeenCalled();
});

it("exits non-zero on Gateway failure without inventing start rows", async () => {
  mocks.callGateway.mockRejectedValue(new Error("unknown channel: nope"));
  await channelsStartCommand({ channel: "nope", json: true }, mocks.runtime as never);
  expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  expect(loggedJson()).toMatchObject({
    ok: false,
    error: { type: "cli_error", message: "unknown channel: nope" },
  });
});
