import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

const runDaemonStatus = vi.fn(async () => {});
const runNodeDaemonStatus = vi.fn(async () => {});

vi.mock("./daemon-cli/runners.js", () => ({
  runDaemonInstall: vi.fn(async () => {}),
  runDaemonRestart: vi.fn(async () => {}),
  runDaemonStart: vi.fn(async () => {}),
  runDaemonStatus: (opts: unknown) => runDaemonStatus(opts),
  runDaemonStop: vi.fn(async () => {}),
  runDaemonUninstall: vi.fn(async () => {}),
}));

vi.mock("./node-cli/daemon.js", () => ({
  runNodeDaemonInstall: vi.fn(async () => {}),
  runNodeDaemonRestart: vi.fn(async () => {}),
  runNodeDaemonStart: vi.fn(async () => {}),
  runNodeDaemonStatus: (opts: unknown) => runNodeDaemonStatus(opts),
  runNodeDaemonStop: vi.fn(async () => {}),
  runNodeDaemonUninstall: vi.fn(async () => {}),
}));

vi.mock("./deps.js", () => ({
  createDefaultDeps: vi.fn(),
}));

describe("service CLI coverage", () => {
  it("routes service gateway status to daemon status", async () => {
    runDaemonStatus.mockClear();
    runNodeDaemonStatus.mockClear();

    const { registerServiceCli } = await import("./service-cli.js");
    const program = new Command();
    program.exitOverride();
    registerServiceCli(program);

    await program.parseAsync(["service", "gateway", "status"], { from: "user" });

    expect(runDaemonStatus).toHaveBeenCalledTimes(1);
    expect(runNodeDaemonStatus).toHaveBeenCalledTimes(0);
  });

  it("routes service node status to node daemon status", async () => {
    runDaemonStatus.mockClear();
    runNodeDaemonStatus.mockClear();

    const { registerServiceCli } = await import("./service-cli.js");
    const program = new Command();
    program.exitOverride();
    registerServiceCli(program);

    await program.parseAsync(["service", "node", "status"], { from: "user" });

    expect(runNodeDaemonStatus).toHaveBeenCalledTimes(1);
    expect(runDaemonStatus).toHaveBeenCalledTimes(0);
  });
});
