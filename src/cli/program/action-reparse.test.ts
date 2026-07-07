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

vi.mock("./helpers.js", () => ({
  resolveActionArgs: resolveActionArgsMock,
  resolveCommandOptionArgs: resolveCommandOptionArgsMock,
}));

function setRawArgs(command: Command, rawArgs: string[]): void {
  (command as Command & { rawArgs: string[] }).rawArgs = rawArgs;
}

function deleteRawArgs(command: Command): void {
  delete (command as Command & { rawArgs?: string[] }).rawArgs;
}

async function expectReparseArgv(params: {
  parent: Command;
  action: Command;
  argv: string[];
  expected: string[];
}): Promise<void> {
  let root = params.parent;
  while (root.parent) {
    root = root.parent;
  }
  setRawArgs(root, params.argv);
  buildParseArgvMock.mockReturnValue(params.argv);
  const parseAsync = vi.spyOn(root, "parseAsync").mockResolvedValue(root);

  await reparseProgramFromActionArgs(params.parent, [params.action]);

  expect(parseAsync).toHaveBeenCalledWith(params.expected);
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
      fallbackArgv: ["workspaces", "audit", "export", "--since", "1"],
    });
    expect(parseAsync).toHaveBeenCalledWith(["node", "openclaw", "status"]);
    expect(auditParseAsync).not.toHaveBeenCalled();
  });

  it("reconstructs the full nested command path when Commander rawArgs is missing", async () => {
    // #83893: nested lazy commands still need their ancestor path if
    // Commander stops exposing root rawArgs at runtime.
    const root = new Command().name("openclaw");
    const workspaces = root.command("workspaces");
    const audit = workspaces.command("audit");
    const exportCommand = audit.command("export");
    deleteRawArgs(root);
    const parseAsync = vi.spyOn(root, "parseAsync").mockResolvedValue(root);
    resolveActionArgsMock.mockReturnValue(["--since", "1"]);

    await reparseProgramFromActionArgs(audit, [exportCommand]);

    expect(buildParseArgvMock).toHaveBeenCalledWith({
      programName: "openclaw",
      rawArgs: undefined,
      fallbackArgv: ["workspaces", "audit", "export", "--since", "1"],
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

  it("falls back to fallbackArgv when Commander rawArgs is missing from the root command", async () => {
    // #83893: rawArgs is a Commander runtime field, so the root command must
    // still reparse from reconstructed argv if Commander stops exposing it.
    const root = new Command().name("openclaw");
    const configCommand = root.command("config");
    deleteRawArgs(root);
    const parseAsync = vi.spyOn(root, "parseAsync").mockResolvedValue(root);
    resolveActionArgsMock.mockReturnValue(["set", "key", "value"]);

    await reparseProgramFromActionArgs(root, [configCommand]);

    expect(buildParseArgvMock).toHaveBeenCalledWith({
      programName: "openclaw",
      rawArgs: undefined,
      fallbackArgv: ["config", "set", "key", "value"],
    });
    expect(parseAsync).toHaveBeenCalled();
  });

  it("hoists a trailing lazy-parent option before the loaded command", async () => {
    const root = new Command().name("openclaw");
    const browser = root.command("browser").option("--browser-profile <name>");
    const tabs = browser.command("tabs");
    await expectReparseArgv({
      parent: browser,
      action: tabs,
      argv: ["node", "openclaw", "browser", "tabs", "--browser-profile", "remote"],
      expected: ["node", "openclaw", "browser", "--browser-profile", "remote", "tabs"],
    });
  });

  it("skips root option values that match the parent command name", async () => {
    const root = new Command().name("openclaw").option("--profile <name>");
    const browser = root.command("browser").option("--browser-profile <name>");
    const tabs = browser.command("tabs");
    await expectReparseArgv({
      parent: browser,
      action: tabs,
      argv: [
        "node",
        "openclaw",
        "--profile",
        "browser",
        "browser",
        "tabs",
        "--browser-profile",
        "remote",
      ],
      expected: [
        "node",
        "openclaw",
        "--profile",
        "browser",
        "browser",
        "--browser-profile",
        "remote",
        "tabs",
      ],
    });
  });

  it("hoists parent options after nested lazy commands", async () => {
    const root = new Command().name("openclaw");
    const browser = root.command("browser").option("--browser-profile <name>");
    const tab = browser.command("tab");
    tab.command("new");
    await expectReparseArgv({
      parent: browser,
      action: tab,
      argv: ["node", "openclaw", "browser", "tab", "new", "--browser-profile", "work"],
      expected: ["node", "openclaw", "browser", "--browser-profile", "work", "tab", "new"],
    });
  });

  it("leaves a child-owned option collision after the child command", async () => {
    const root = new Command().name("openclaw");
    const browser = root.command("browser").option("--json");
    const extension = browser.command("extension");
    extension.command("path");
    extension.command("pair").option("--json");
    const argv = ["node", "openclaw", "browser", "extension", "pair", "--json"];
    await expectReparseArgv({ parent: browser, action: extension, argv, expected: argv });
  });

  it("hoists a parent option when only a sibling command owns the same flag", async () => {
    const root = new Command().name("openclaw");
    const browser = root.command("browser").option("--url <url>");
    const cookies = browser.command("cookies");
    cookies.command("list");
    cookies.command("set").option("--url <url>");
    await expectReparseArgv({
      parent: browser,
      action: cookies,
      argv: ["node", "openclaw", "browser", "cookies", "list", "--url", "ws://gateway"],
      expected: ["node", "openclaw", "browser", "--url", "ws://gateway", "cookies", "list"],
    });
  });

  it("keeps a missing parent option value after the loaded command", async () => {
    const root = new Command().name("openclaw");
    const browser = root.command("browser").option("--browser-profile <name>");
    const tabs = browser.command("tabs");
    const argv = ["node", "openclaw", "browser", "tabs", "--browser-profile"];
    await expectReparseArgv({ parent: browser, action: tabs, argv, expected: argv });
  });
});
