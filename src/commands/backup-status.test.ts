import { Command } from "commander";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
}));

vi.mock("../cli/gateway-rpc.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cli/gateway-rpc.js")>();
  return {
    ...actual,
    callGatewayFromCliWithTransport: mocks.callGateway,
  };
});

import { registerBackupCommand } from "../cli/program/register.backup.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.callGateway.mockResolvedValue({ targets: [], schedules: [], locations: [] });
});

async function parseStatus(...args: string[]) {
  const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
  registerBackupCommand(program);
  await program.parseAsync(["backup", "status", ...args], { from: "user" });
}

it("registers backup status and forwards advertised --port through the Gateway transport", async () => {
  await parseStatus("--port", "18794", "--token", "tok", "--timeout", "12000", "--json");
  expect(mocks.callGateway).toHaveBeenCalledExactlyOnceWith(
    "backup.status",
    expect.objectContaining({
      port: "18794",
      token: "tok",
      timeout: "12000",
      json: true,
    }),
    {},
    { defaultTimeoutMs: 30_000 },
  );
});

it("forwards --url targeting through the registered CLI without dropping GatewayRpcOpts", async () => {
  await parseStatus(
    "--url",
    "ws://127.0.0.1:18794",
    "--token",
    "tok",
    "--password",
    "pw",
    "--json",
  );
  expect(mocks.callGateway).toHaveBeenCalledExactlyOnceWith(
    "backup.status",
    expect.objectContaining({
      url: "ws://127.0.0.1:18794",
      token: "tok",
      password: "pw",
      json: true,
    }),
    {},
    { defaultTimeoutMs: 30_000 },
  );
});
