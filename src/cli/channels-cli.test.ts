import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerChannelsCli } from "./channels-cli.js";

const mocks = vi.hoisted(() => ({
  channelsStatusCommand: vi.fn().mockResolvedValue(undefined),
  noopAsync: vi.fn(async () => undefined),
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("./cli-utils.js", () => ({
  runCommandWithRuntime: async (_runtime: unknown, action: () => Promise<void>) => await action(),
}));

vi.mock("../commands/channels.js", () => ({
  channelsAddCommand: mocks.noopAsync,
  channelsCapabilitiesCommand: mocks.noopAsync,
  channelsListCommand: mocks.noopAsync,
  channelsLogsCommand: mocks.noopAsync,
  channelsRemoveCommand: mocks.noopAsync,
  channelsResolveCommand: mocks.noopAsync,
  channelsStatusCommand: mocks.channelsStatusCommand,
}));

describe("channels cli", () => {
  beforeEach(() => {
    mocks.channelsStatusCommand.mockClear();
  });

  async function runChannelsCommand(argv: string[]) {
    const program = new Command();
    registerChannelsCli(program);
    await program.parseAsync(argv, { from: "user" });
  }

  it("does not inject a commander timeout default for channels status --probe", async () => {
    await runChannelsCommand(["channels", "status", "--probe"]);

    const [opts, runtime] = mocks.channelsStatusCommand.mock.calls[0] ?? [];
    expect(opts).toEqual(
      expect.objectContaining({
        probe: true,
      }),
    );
    expect(opts).not.toHaveProperty("timeout");
    expect(runtime).toEqual(expect.any(Object));
  });

  it("passes explicit timeout values through to channels status", async () => {
    await runChannelsCommand(["channels", "status", "--probe", "--timeout", "5000"]);

    expect(mocks.channelsStatusCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        probe: true,
        timeout: "5000",
      }),
      expect.any(Object),
    );
  });
});
