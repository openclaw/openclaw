import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reparseProgramFromActionArgs } from "./action-reparse.js";

const buildParseArgvMock = vi.hoisted(() => vi.fn());
const resolveActionArgsMock = vi.hoisted(() => vi.fn());
const resolveCommandOptionArgsMock = vi.hoisted(() => vi.fn());
const warnMock = vi.hoisted(() => vi.fn());

vi.mock("../argv.js", () => ({
  buildParseArgv: buildParseArgvMock,
}));

vi.mock("./helpers.js", () => ({
  resolveActionArgs: resolveActionArgsMock,
  resolveCommandOptionArgs: resolveCommandOptionArgsMock,
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnMock,
    error: vi.fn(),
    fatal: vi.fn(),
  }),
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
    const parseAsync = vi.spyOn(program, "parseAsync").mockResolvedValue(program);
    const actionCommand = {
      name: () => "status",
      parent: {
        rawArgs: ["node", "openclaw", "status", "--json"],
      },
    } as unknown as Command;
    resolveActionArgsMock.mockReturnValue(["--json"]);

    await reparseProgramFromActionArgs(program, [actionCommand]);

    expect(buildParseArgvMock).toHaveBeenCalledWith({
      programName: "openclaw",
      rawArgs: ["node", "openclaw", "status", "--json"],
      fallbackArgv: ["status", "--json"],
    });
    expect(parseAsync).toHaveBeenCalledWith(["node", "openclaw", "status"]);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it("falls back to action args without command name when action has no name", async () => {
    const program = new Command().name("openclaw");
    const parseAsync = vi.spyOn(program, "parseAsync").mockResolvedValue(program);
    const actionCommand = {
      name: () => "",
      parent: {},
    } as unknown as Command;
    resolveActionArgsMock.mockReturnValue(["--json"]);

    await reparseProgramFromActionArgs(program, [actionCommand]);

    expect(buildParseArgvMock).toHaveBeenCalledWith({
      programName: "openclaw",
      rawArgs: undefined,
      fallbackArgv: ["--json"],
    });
    expect(parseAsync).toHaveBeenCalledWith(["node", "openclaw", "status"]);
    // A plain mock object is not a Command instance, so the missing rawArgs is
    // expected and must not produce a warning.
    expect(warnMock).not.toHaveBeenCalled();
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
    // A real Command initializes rawArgs to [] before parse — that is a valid
    // empty array, not a degraded state, so no warning is expected.
    expect(warnMock).not.toHaveBeenCalled();
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
    expect(warnMock).not.toHaveBeenCalled();
  });

  it("warns when a real Command instance is missing rawArgs (commander API drift)", async () => {
    const program = new Command().name("openclaw");
    const parseAsync = vi.spyOn(program, "parseAsync").mockResolvedValue(program);
    // Simulate a future Commander that removed/renamed rawArgs on a real
    // Command instance.
    const parent = new Command().name("openclaw");
    delete (parent as Command & { rawArgs?: unknown }).rawArgs;
    const actionCommand = {
      name: () => "status",
      parent,
    } as unknown as Command;

    await reparseProgramFromActionArgs(program, [actionCommand]);

    expect(buildParseArgvMock).toHaveBeenCalledWith(
      expect.objectContaining({ rawArgs: undefined }),
    );
    expect(parseAsync).toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock).toHaveBeenCalledWith(
      expect.stringContaining("commander rawArgs"),
      expect.objectContaining({ typeofRawArgs: "undefined" }),
    );
  });

  it("warns when a real Command instance has a non-array rawArgs (commander type drift)", async () => {
    const program = new Command().name("openclaw");
    const parseAsync = vi.spyOn(program, "parseAsync").mockResolvedValue(program);
    const parent = new Command().name("openclaw");
    (parent as Command & { rawArgs?: unknown }).rawArgs = "not-an-array";
    const actionCommand = {
      name: () => "status",
      parent,
    } as unknown as Command;

    await reparseProgramFromActionArgs(program, [actionCommand]);

    expect(buildParseArgvMock).toHaveBeenCalledWith(
      expect.objectContaining({ rawArgs: undefined }),
    );
    expect(parseAsync).toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock).toHaveBeenCalledWith(
      expect.stringContaining("commander rawArgs"),
      expect.objectContaining({ typeofRawArgs: "string" }),
    );
  });
});
