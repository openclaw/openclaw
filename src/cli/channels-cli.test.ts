import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(() => {
      throw new Error("exit");
    }),
  },
  channelsAddCommand: vi.fn(async () => {}),
}));

vi.mock("../runtime.js", () => ({ defaultRuntime: mocks.runtime }));
vi.mock("./cli-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cli-utils.js")>();
  return {
    ...actual,
    runCommandWithRuntime: async (_runtime: unknown, action: () => Promise<void>) => {
      await action();
    },
  };
});
vi.mock("../commands/channels.js", () => ({
  channelsAddCommand: mocks.channelsAddCommand,
}));

const { registerChannelsCli } = await import("./channels-cli.js");

describe("registerChannelsCli", () => {
  beforeEach(() => {
    mocks.channelsAddCommand.mockClear();
    mocks.runtime.log.mockClear();
    mocks.runtime.error.mockClear();
    mocks.runtime.exit.mockClear();
  });

  it("forwards --soul to channels add", async () => {
    const program = new Command();
    registerChannelsCli(program);

    await program.parseAsync(
      ["channels", "add", "--channel", "slack", "--bot-token", "xoxb-1", "--soul", "SOUL.work.md"],
      { from: "user" },
    );

    expect(mocks.channelsAddCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        botToken: "xoxb-1",
        soul: "SOUL.work.md",
      }),
      mocks.runtime,
      expect.objectContaining({ hasFlags: true }),
    );
  });
});
