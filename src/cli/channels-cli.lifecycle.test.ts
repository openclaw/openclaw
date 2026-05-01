import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerChannelsCli } from "./channels-cli.js";

const mocks = vi.hoisted(() => ({
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
  channelsLifecycleCommand: vi.fn(async () => {}),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

vi.mock("../plugins/bundled-package-channel-metadata.js", () => ({
  listBundledPackageChannelMetadata: () => [],
}));

vi.mock("./channel-options.js", () => ({
  formatCliChannelOptions: () => "whatsapp|telegram",
}));

vi.mock("../commands/channels.js", () => ({
  channelsLifecycleCommand: mocks.channelsLifecycleCommand,
}));

describe("channels CLI lifecycle commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createProgram() {
    const program = new Command();
    program.exitOverride();
    registerChannelsCli(program);
    return program;
  }

  it("registers start, stop, and restart commands", () => {
    const channels = createProgram().commands.find((command) => command.name() === "channels");

    expect(channels?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["start", "stop", "restart"]),
    );
  });

  it.each(["start", "stop", "restart"] as const)(
    "routes channels %s to the lifecycle command",
    async (action) => {
      const program = createProgram();

      await program.parseAsync([
        "node",
        "openclaw",
        "channels",
        action,
        "--channel",
        "whatsapp",
        "--account",
        "acct-1",
        "--json",
      ]);

      expect(mocks.channelsLifecycleCommand).toHaveBeenCalledWith(
        action,
        {
          channel: "whatsapp",
          account: "acct-1",
          json: true,
        },
        mocks.runtime,
      );
    },
  );
});
