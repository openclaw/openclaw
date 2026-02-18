import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addGatewayServiceCommands } from "./register-service-commands.js";

const runDaemonInstall = vi.fn(async (_opts: unknown) => {});
const runDaemonRestart = vi.fn(async (_opts: unknown) => {});
const runDaemonStart = vi.fn(async (_opts: unknown) => {});
const runDaemonStatus = vi.fn(async (_opts: unknown) => {});
const runDaemonStop = vi.fn(async (_opts: unknown) => {});
const runDaemonUninstall = vi.fn(async (_opts: unknown) => {});

vi.mock("./runners.js", () => ({
  runDaemonInstall: (opts: unknown) => runDaemonInstall(opts),
  runDaemonRestart: (opts: unknown) => runDaemonRestart(opts),
  runDaemonStart: (opts: unknown) => runDaemonStart(opts),
  runDaemonStatus: (opts: unknown) => runDaemonStatus(opts),
  runDaemonStop: (opts: unknown) => runDaemonStop(opts),
  runDaemonUninstall: (opts: unknown) => runDaemonUninstall(opts),
}));

function createGatewayParentLikeCommand() {
  const gateway = new Command().name("gateway");
  // Mirror overlapping root gateway options that conflict with service subcommand options.
  gateway.option("--port <port>", "Port for the gateway WebSocket");
  gateway.option("--token <token>", "Gateway token");
  gateway.option("--password <password>", "Gateway password");
  gateway.option("--force", "Gateway run --force", false);
  addGatewayServiceCommands(gateway);
  return gateway;
}

describe("addGatewayServiceCommands", () => {
  beforeEach(() => {
    runDaemonInstall.mockClear();
    runDaemonRestart.mockClear();
    runDaemonStart.mockClear();
    runDaemonStatus.mockClear();
    runDaemonStop.mockClear();
    runDaemonUninstall.mockClear();
  });

  it("forwards install option collisions from parent gateway command", async () => {
    const gateway = createGatewayParentLikeCommand();
    await gateway.parseAsync(["install", "--force", "--port", "19000", "--token", "tok_test"], {
      from: "user",
    });

    expect(runDaemonInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        force: true,
        port: "19000",
        token: "tok_test",
      }),
    );
  });

  it("forwards status auth collisions from parent gateway command", async () => {
    const gateway = createGatewayParentLikeCommand();
    await gateway.parseAsync(["status", "--token", "tok_status", "--password", "pw_status"], {
      from: "user",
    });

    expect(runDaemonStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        rpc: expect.objectContaining({
          token: "tok_status",
          password: "pw_status",
        }),
      }),
    );
  });
});
