import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reparseProgramFromActionArgs } from "./action-reparse.js";

const buildParseArgvMock = vi.hoisted(() => vi.fn());
const resolveActionArgsMock = vi.hoisted(() => vi.fn());
const resolveCommandOptionArgsMock = vi.hoisted(() => vi.fn());

vi.mock("../argv.js", () => ({
  buildParseArgv: buildParseArgvMock,
}));

vi.mock("./helpers.js", () => ({
  resolveActionArgs: resolveActionArgsMock,
  resolveCommandOptionArgs: resolveCommandOptionArgsMock,
}));

describe("reparseProgramFromActionArgs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildParseArgvMock.mockReturnValue(["node", "openclaw", "status"]);
    resolveActionArgsMock.mockReturnValue([]);
    resolveCommandOptionArgsMock.mockReturnValue([]);
  });

  it("uses action command name + args as fallback argv", async () => {
    const program = new Command().name("openclaw");
    (program as Command & { rawArgs?: string[] }).rawArgs = [
      "node",
      "openclaw",
      "status",
      "--json",
    ];
    const parseAsync = vi.spyOn(program, "parseAsync").mockResolvedValue(program);
    const actionCommand = program.command("status");
    resolveActionArgsMock.mockReturnValue(["--json"]);

    await reparseProgramFromActionArgs(program, [actionCommand]);

    expect(buildParseArgvMock).toHaveBeenCalledWith({
      programName: "openclaw",
      rawArgs: ["node", "openclaw", "status", "--json"],
      fallbackArgv: ["status", "--json"],
    });
    expect(parseAsync).toHaveBeenCalledWith(["node", "openclaw", "status"]);
  });

  it("falls back to action args without command name when action has no name", async () => {
    const program = new Command().name("openclaw");
    const parseAsync = vi.spyOn(program, "parseAsync").mockResolvedValue(program);
    const actionCommand = new Command();
    resolveActionArgsMock.mockReturnValue(["--json"]);

    await reparseProgramFromActionArgs(program, [actionCommand]);

    expect(buildParseArgvMock).toHaveBeenCalledWith({
      programName: "openclaw",
      rawArgs: [],
      fallbackArgv: ["--json"],
    });
    expect(parseAsync).toHaveBeenCalledWith(["node", "openclaw", "status"]);
  });

  it("preserves explicit parent command options in fallback argv", async () => {
    const program = new Command().name("browser");
    const parseAsync = vi.spyOn(program, "parseAsync").mockResolvedValue(program);
    const actionCommand = {
      name: () => "open",
      parent: program,
    } as unknown as Command;
    resolveActionArgsMock.mockReturnValue(["about:blank"]);
    resolveCommandOptionArgsMock.mockReturnValue(["--json"]);

    await reparseProgramFromActionArgs(program, [actionCommand]);

    expect(resolveCommandOptionArgsMock).toHaveBeenCalledWith(program);
    expect(buildParseArgvMock).toHaveBeenCalledWith({
      programName: "browser",
      rawArgs: [],
      fallbackArgv: ["--json", "open", "about:blank"],
    });
    expect(parseAsync).toHaveBeenCalledWith(["node", "openclaw", "status"]);
  });

  it("uses program root when action command is missing", async () => {
    const program = new Command().name("openclaw");
    const parseAsync = vi.spyOn(program, "parseAsync").mockResolvedValue(program);

    await reparseProgramFromActionArgs(program, []);

    expect(resolveActionArgsMock).toHaveBeenCalledWith(undefined);
    expect(buildParseArgvMock).toHaveBeenCalledWith({
      programName: "openclaw",
      rawArgs: [],
      fallbackArgv: [],
    });
    expect(parseAsync).toHaveBeenCalledWith(["node", "openclaw", "status"]);
  });

  it("walks up to the root program when reparsing from a nested sub-command action", async () => {
    // Reproduces the lazy-CLI bug: when a sub-command is dispatched via
    // _dispatchSubcommand, its rawArgs are not populated by commander, and
    // reparsing on the immediate parent strips parent options from the
    // reconstructed argv. The fix walks up to the root program so the original
    // argv (including parent options) is preserved.
    const program = new Command().name("openclaw");
    (program as Command & { rawArgs?: string[] }).rawArgs = [
      "node",
      "openclaw",
      "browser",
      "--browser-profile",
      "nuan",
      "status",
    ];
    const programParseAsync = vi.spyOn(program, "parseAsync").mockResolvedValue(program);
    const browser = program.command("browser");
    const browserParseAsync = vi.spyOn(browser, "parseAsync").mockResolvedValue(browser);
    const status = browser.command("status");
    resolveActionArgsMock.mockReturnValue([]);

    // Caller passes the immediate parent (browser), as registerLazyCommand does.
    await reparseProgramFromActionArgs(browser, [status]);

    expect(buildParseArgvMock).toHaveBeenCalledWith({
      programName: "openclaw",
      rawArgs: ["node", "openclaw", "browser", "--browser-profile", "nuan", "status"],
      fallbackArgv: ["status"],
    });
    expect(programParseAsync).toHaveBeenCalledWith(["node", "openclaw", "status"]);
    expect(browserParseAsync).not.toHaveBeenCalled();
  });
});
