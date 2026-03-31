import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runGatewayAuthRotateCommand = vi.fn();

vi.mock("../commands/auth-rotate.js", () => ({
  runGatewayAuthRotateCommand: (...args: unknown[]) => runGatewayAuthRotateCommand(...args),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
    writeJson: vi.fn(),
  },
}));

vi.mock("./cli-utils.js", () => ({
  runCommandWithRuntime: async (_runtime: unknown, action: () => Promise<void>) => {
    await action();
  },
}));

const { registerAuthCli } = await import("./auth-cli.js");

describe("registerAuthCli", () => {
  beforeEach(() => {
    runGatewayAuthRotateCommand.mockReset();
    runGatewayAuthRotateCommand.mockResolvedValue(undefined);
  });

  it("registers auth rotate", async () => {
    const program = new Command();
    program.exitOverride();
    registerAuthCli(program);

    await program.parseAsync(["auth", "rotate"], { from: "user" });

    expect(runGatewayAuthRotateCommand).toHaveBeenCalledTimes(1);
  });
});
