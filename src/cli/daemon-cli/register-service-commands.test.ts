import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addGatewayServiceCommands } from "./register-service-commands.js";

const runDaemonInstall = vi.fn(async (_opts: unknown) => {});
const runDaemonRestart = vi.fn(async (_opts: unknown) => {});
const runGatewaySnapshotPrune = vi.fn(async (_opts: unknown) => {});
const runGatewaySnapshotRollback = vi.fn(async (_opts: unknown) => {});
const runGatewaySnapshotStatus = vi.fn(async (_opts: unknown) => {});
const runDaemonStart = vi.fn(async (_opts: unknown) => {});
const runDaemonStatus = vi.fn(async (_opts: unknown) => {});
const runDaemonStop = vi.fn(async (_opts: unknown) => {});
const runDaemonUninstall = vi.fn(async (_opts: unknown) => {});

vi.mock("./install.runtime.js", () => ({
  runDaemonInstall: (opts: unknown) => runDaemonInstall(opts),
}));

vi.mock("./status.runtime.js", () => ({
  runDaemonStatus: (opts: unknown) => runDaemonStatus(opts),
}));

vi.mock("./lifecycle.runtime.js", () => ({
  runDaemonRestart: (opts: unknown) => runDaemonRestart(opts),
  runDaemonStart: (opts: unknown) => runDaemonStart(opts),
  runDaemonStop: (opts: unknown) => runDaemonStop(opts),
  runDaemonUninstall: (opts: unknown) => runDaemonUninstall(opts),
}));

vi.mock("./snapshot.runtime.js", () => ({
  runGatewaySnapshotPrune: (opts: unknown) => runGatewaySnapshotPrune(opts),
  runGatewaySnapshotRollback: (opts: unknown) => runGatewaySnapshotRollback(opts),
  runGatewaySnapshotStatus: (opts: unknown) => runGatewaySnapshotStatus(opts),
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
    runGatewaySnapshotPrune.mockClear();
    runGatewaySnapshotRollback.mockClear();
    runGatewaySnapshotStatus.mockClear();
    runDaemonStart.mockClear();
    runDaemonStatus.mockClear();
    runDaemonStop.mockClear();
    runDaemonUninstall.mockClear();
  });

  it.each([
    {
      name: "forwards install option collisions from parent gateway command",
      argv: ["install", "--force", "--port", "19000", "--token", "tok_test"],
      assert: () => {
        expect(runDaemonInstall).toHaveBeenCalledWith(
          expect.objectContaining({
            force: true,
            port: "19000",
            token: "tok_test",
          }),
        );
      },
    },
    {
      name: "forwards restart force and wait controls",
      argv: ["restart", "--wait", "30s"],
      assert: () => {
        expect(runDaemonRestart).toHaveBeenCalledWith(
          expect.objectContaining({
            wait: "30s",
          }),
        );
      },
    },
    {
      name: "forwards restart safe control",
      argv: ["restart", "--safe"],
      assert: () => {
        expect(runDaemonRestart).toHaveBeenCalledWith(
          expect.objectContaining({
            safe: true,
          }),
        );
      },
    },
    {
      name: "forwards restart force control",
      argv: ["restart", "--force"],
      assert: () => {
        expect(runDaemonRestart).toHaveBeenCalledWith(
          expect.objectContaining({
            force: true,
          }),
        );
      },
    },
    {
      name: "forwards status auth collisions from parent gateway command",
      argv: ["status", "--token", "tok_status", "--password", "pw_status"],
      assert: () => {
        expect(runDaemonStatus).toHaveBeenCalledWith(
          expect.objectContaining({
            rpc: expect.objectContaining({
              token: "tok_status",
              password: "pw_status", // pragma: allowlist secret
            }),
          }),
        );
      },
    },
    {
      name: "forwards require-rpc for status",
      argv: ["status", "--require-rpc"],
      assert: () => {
        expect(runDaemonStatus).toHaveBeenCalledWith(
          expect.objectContaining({
            requireRpc: true,
          }),
        );
      },
    },
    {
      name: "forwards snapshot status json",
      argv: ["snapshot", "status", "--json"],
      assert: () => {
        expect(runGatewaySnapshotStatus).toHaveBeenCalledWith({ json: true });
      },
    },
    {
      name: "forwards snapshot prune keep count",
      argv: ["snapshot", "prune", "--keep", "4"],
      assert: () => {
        expect(runGatewaySnapshotPrune).toHaveBeenCalledWith({ keep: "4", json: false });
      },
    },
    {
      name: "forwards snapshot rollback release id",
      argv: ["snapshot", "rollback", "release-a"],
      assert: () => {
        expect(runGatewaySnapshotRollback).toHaveBeenCalledWith({
          releaseId: "release-a",
          json: false,
        });
      },
    },
  ])("$name", async ({ argv, assert }) => {
    const gateway = createGatewayParentLikeCommand();
    await gateway.parseAsync(argv, { from: "user" });
    assert();
  });
});
