import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("plugins cli lazy runtime boundary", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("./plugins-cli.runtime.js");
    vi.doUnmock("./plugins-search-command.js");
    vi.resetModules();
  });

  it("renders parent help without importing the plugins runtime", async () => {
    const runtimeLoaded = vi.fn();
    vi.doMock("./plugins-cli.runtime.js", () => {
      runtimeLoaded();
      return {
        runPluginMarketplaceListCommand: vi.fn(),
        runPluginsDisableCommand: vi.fn(),
        runPluginsDoctorCommand: vi.fn(),
        runPluginsEnableCommand: vi.fn(),
        runPluginsInstallAction: vi.fn(),
        runPluginsRegistryCommand: vi.fn(),
      };
    });

    const { registerPluginsCli } = await import("./plugins-cli.js");
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
      writeOut: () => {},
    });
    registerPluginsCli(program);

    await expect(program.parseAsync(["plugins", "--help"], { from: "user" })).rejects.toMatchObject(
      {
        exitCode: 0,
      },
    );
    expect(runtimeLoaded).not.toHaveBeenCalled();
  });

  it("rejects invalid plugins search limit before loading the search action", async () => {
    let searchLoaded = false;
    vi.doMock("./plugins-search-command.js", () => {
      searchLoaded = true;
      return {
        runPluginsSearchCommand: vi.fn(),
      };
    });

    const { registerPluginsCli } = await import("./plugins-cli.js");
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
      writeOut: () => {},
    });
    registerPluginsCli(program);

    await expect(
      program.parseAsync(["plugins", "search", "calendar", "--limit", "1abc"], {
        from: "user",
      }),
    ).rejects.toMatchObject({
      code: "commander.invalidArgument",
      exitCode: 1,
    });
    expect(searchLoaded).toBe(false);
  });

  it("parses valid plugins search limits for the search action", async () => {
    const runPluginsSearchCommand = vi.fn().mockResolvedValue(undefined);
    vi.doMock("./plugins-search-command.js", () => ({
      runPluginsSearchCommand,
    }));

    const { registerPluginsCli } = await import("./plugins-cli.js");
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
      writeOut: () => {},
    });
    registerPluginsCli(program);

    await program.parseAsync(["plugins", "search", "calendar", "--limit", "+10", "--json"], {
      from: "user",
    });

    expect(runPluginsSearchCommand).toHaveBeenCalledWith(
      ["calendar"],
      expect.objectContaining({ json: true, limit: 10 }),
    );
  });

  it("loads the plugins runtime for runtime-backed actions", async () => {
    const runPluginsRegistryCommand = vi.fn().mockResolvedValue(undefined);
    const runtimeLoaded = vi.fn();
    vi.doMock("./plugins-cli.runtime.js", () => {
      runtimeLoaded();
      return {
        runPluginMarketplaceListCommand: vi.fn(),
        runPluginsDisableCommand: vi.fn(),
        runPluginsDoctorCommand: vi.fn(),
        runPluginsEnableCommand: vi.fn(),
        runPluginsInstallAction: vi.fn(),
        runPluginsRegistryCommand,
      };
    });

    const { registerPluginsCli } = await import("./plugins-cli.js");
    const program = new Command();
    registerPluginsCli(program);

    await program.parseAsync(["plugins", "registry", "--json"], { from: "user" });

    expect(runtimeLoaded).toHaveBeenCalledTimes(1);
    expect(runPluginsRegistryCommand).toHaveBeenCalledWith(expect.objectContaining({ json: true }));
  });
});
