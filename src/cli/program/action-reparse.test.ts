// Action reparse tests cover Commander action reparsing for nested CLI commands.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reparseProgramFromActionArgs } from "./action-reparse.js";

const buildParseArgvMock = vi.hoisted(() => vi.fn());
const resolveActionArgsMock = vi.hoisted(() => vi.fn());
const resolveCommandOptionArgsMock = vi.hoisted(() => vi.fn());

vi.mock("../argv.js", () => ({
  buildParseArgv: buildParseArgvMock,
}));

vi.mock("./helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./helpers.js")>();
  return {
    ...actual,
    resolveActionArgs: resolveActionArgsMock,
    resolveCommandOptionArgs: resolveCommandOptionArgsMock,
  };
});

function setRawArgs(command: Command, rawArgs: string[]): void {
  (command as Command & { rawArgs: string[] }).rawArgs = rawArgs;
}

describe("reparseProgramFromActionArgs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildParseArgvMock.mockReturnValue(["node", "openclaw", "status"]);
    resolveActionArgsMock.mockReturnValue([]);
    resolveCommandOptionArgsMock.mockReturnValue([]);
  });

  it("uses action command name + args as fallback argv", async () => {
    const program = new Command().name("openclaw");
    setRawArgs(program, ["node", "openclaw", "status", "--json"]);
    const parseAsync = vi.spyOn(program, "parseAsync").mockResolvedValue(program);
    const actionCommand = {
      name: () => "status",
      parent: program,
    } as unknown as Command;
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
    setRawArgs(program, ["node", "openclaw"]);
    const parseAsync = vi.spyOn(program, "parseAsync").mockResolvedValue(program);
    const actionCommand = {
      name: () => "",
      parent: program,
    } as unknown as Command;
    resolveActionArgsMock.mockReturnValue(["--json"]);

    await reparseProgramFromActionArgs(program, [actionCommand]);

    expect(buildParseArgvMock).toHaveBeenCalledWith({
      programName: "openclaw",
      rawArgs: ["node", "openclaw"],
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

  it("uses root raw args and reparses the root for nested lazy commands", async () => {
    const root = new Command().name("openclaw");
    setRawArgs(root, ["node", "openclaw", "workspaces", "audit", "export", "--since", "1"]);
    const workspaces = root.command("workspaces");
    const audit = workspaces.command("audit");
    const exportCommand = audit.command("export");
    const parseAsync = vi.spyOn(root, "parseAsync").mockResolvedValue(root);
    const auditParseAsync = vi.spyOn(audit, "parseAsync");
    resolveActionArgsMock.mockReturnValue(["--since", "1"]);

    await reparseProgramFromActionArgs(audit, [exportCommand]);

    expect(buildParseArgvMock).toHaveBeenCalledWith({
      programName: "openclaw",
      rawArgs: ["node", "openclaw", "workspaces", "audit", "export", "--since", "1"],
      fallbackArgv: ["export", "--since", "1"],
    });
    expect(parseAsync).toHaveBeenCalledWith(["node", "openclaw", "status"]);
    expect(auditParseAsync).not.toHaveBeenCalled();
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

  it("hoists parent options placed after a lazy subcommand before re-parsing", async () => {
    const root = new Command().name("openclaw");
    const browser = root
      .command("browser")
      .option("--browser-profile <name>", "Browser profile name")
      .option("--json", "JSON output", false);
    browser.command("tabs").description("List tabs");
    setRawArgs(root, ["node", "openclaw", "browser", "tabs", "--browser-profile", "remote"]);
    buildParseArgvMock.mockReturnValue([
      "node",
      "openclaw",
      "browser",
      "tabs",
      "--browser-profile",
      "remote",
    ]);
    const parseAsync = vi.spyOn(root, "parseAsync").mockResolvedValue(root);
    const actionCommand = {
      name: () => "tabs",
      parent: browser,
    } as unknown as Command;

    await reparseProgramFromActionArgs(browser, [actionCommand]);

    expect(parseAsync).toHaveBeenCalledWith([
      "node",
      "openclaw",
      "browser",
      "--browser-profile",
      "remote",
      "tabs",
    ]);
  });
});
