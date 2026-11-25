import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("plugins cli lazy runtime boundary", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("./plugins-cli.runtime.js");
    vi.doUnmock("./plugins-marketplace-list-command.js");
    vi.doUnmock("./plugins-authoring-command.js");
    vi.resetModules();
  });

  it.each([
    {
      name: "plugins",
      argv: ["plugins"],
      description: "Manage OpenClaw plugins and extensions",
    },
    {
      name: "plugins marketplace",
      argv: ["plugins", "marketplace"],
      description: "Inspect Claude-compatible plugin marketplaces",
    },
  ])("renders $name parent help successfully without importing the runtime", async (testCase) => {
    const runtimeLoaded = vi.fn();
    vi.doMock("./plugins-cli.runtime.js", () => {
      runtimeLoaded();
      return {};
    });
    vi.doMock("./plugins-marketplace-list-command.js", () => {
      runtimeLoaded();
      return {};
    });

    const { registerPluginsCli } = await import("./plugins-cli.js");
    const program = new Command();
    const helpOutput: string[] = [];
    program.exitOverride();
    program.configureOutput({
      writeErr: (value) => helpOutput.push(value),
      writeOut: (value) => helpOutput.push(value),
    });
    registerPluginsCli(program);

    const originalExitCode = process.exitCode;
    try {
      process.exitCode = undefined;
      await program.parseAsync(testCase.argv, { from: "user" });

      expect(process.exitCode).toBe(0);
      expect(helpOutput.join("")).toContain(testCase.description);
      expect(runtimeLoaded).not.toHaveBeenCalled();
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it("forwards JSON mode to plugin validation", async () => {
    const runPluginsValidateCommand = vi.fn().mockResolvedValue(undefined);
    vi.doMock("./plugins-authoring-command.js", () => ({ runPluginsValidateCommand }));

    const { registerPluginsCli } = await import("./plugins-cli.js");
    const validateProgram = new Command();
    registerPluginsCli(validateProgram);
    await validateProgram.parseAsync(["plugins", "validate", "--json"], { from: "user" });

    expect(runPluginsValidateCommand).toHaveBeenCalledWith(
      expect.objectContaining({ json: true }),
      expect.any(Command),
    );
  });
});
