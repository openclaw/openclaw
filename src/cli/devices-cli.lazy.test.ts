import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("devices cli lazy runtime boundary", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("./devices-cli.runtime.js");
    vi.doUnmock("./devices-cli-join.js");
    vi.resetModules();
  });

  it("renders parent help without importing the devices runtime", async () => {
    const runtimeLoaded = vi.fn();
    vi.doMock("./devices-cli.runtime.js", () => {
      runtimeLoaded();
      throw new Error("devices runtime loaded during help");
    });
    const joinLoaded = vi.fn();
    // mock-isolation: Loading the real join module would defeat this cold-help import sentinel.
    vi.doMock("./devices-cli-join.js", () => {
      joinLoaded();
      throw new Error("join runtime loaded during help");
    });

    const { registerDevicesCli } = await import("./devices-cli.js");
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
      writeOut: () => {},
    });
    registerDevicesCli(program);

    await expect(program.parseAsync(["devices", "--help"], { from: "user" })).rejects.toMatchObject(
      {
        exitCode: 0,
      },
    );
    expect(runtimeLoaded).not.toHaveBeenCalled();
    expect(joinLoaded).not.toHaveBeenCalled();
  });
});
