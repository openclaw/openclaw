// Action reparse tests cover Commander action reparsing for nested CLI commands.
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { removeCommandByName } from "./command-tree.js";
import { registerCommandGroups } from "./register-command-groups.js";

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
  removeCommandByName(params.parent, params.action.name());
  registerCommandGroups(
    params.parent,
    [
      {
        placeholders: [{ name: params.action.name(), description: "Lazy test command" }],
        register: () => {
          params.parent.addCommand(params.action);
        },
      },
    ],
    { eager: false, primary: null, registerPrimaryOnly: false },
  );
  const parse = root.parseAsync.bind(root);
  const parseAsync = vi.spyOn(root, "parseAsync").mockResolvedValue(root);
  parseAsync.mockImplementationOnce(parse);

  await root.parseAsync(params.argv);

  expect(parseAsync).toHaveBeenCalledTimes(2);
  expect(parseAsync).toHaveBeenLastCalledWith(params.expected);
}

describe("lazy command action reparsing", () => {
  it("keeps literal flag-looking values through actual lazy reparse", async () => {
    const program = new Command().name("openclaw").enablePositionalOptions();
    const received: string[] = [];
    registerCommandGroups(
      program,
      [
        {
          placeholders: [{ name: "config", description: "Read config" }],
          register: () => {
            program
              .command("config")
              .command("get")
              .argument("<path>")
              .action((value: string) => {
                received.push(value);
              });
          },
        },
      ],
      { eager: false, primary: null, registerPrimaryOnly: false },
    );
    await program.parseAsync(["node", "openclaw", "config", "get", "--", "--help"]);
    expect(received).toEqual(["--help"]);
  });

  it("uses root raw args and reparses the root for nested lazy commands", async () => {
    const root = new Command().name("openclaw");
    const workspaces = root.command("workspaces");
    const audit = workspaces.command("audit");
    const exportCommand = audit.command("export");
    const auditParseAsync = vi.spyOn(audit, "parseAsync");

    const argv = ["node", "openclaw", "workspaces", "audit", "export", "--since", "1"];
    await expectReparseArgv({ parent: audit, action: exportCommand, argv, expected: argv });
    expect(auditParseAsync).not.toHaveBeenCalled();
  });

  it("skips an attached root option value that matches the parent command name", async () => {
    const root = new Command().name("openclaw").option("-p, --profile <name>");
    const browser = root.command("browser").option("--browser-profile <name>");
    const tabs = browser.command("tabs");
    await expectReparseArgv({
      parent: browser,
      action: tabs,
      argv: ["node", "openclaw", "-pbrowser", "browser", "tabs", "--browser-profile", "remote"],
      expected: ["node", "openclaw", "-pbrowser", "browser", "--browser-profile", "remote", "tabs"],
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

  it("preserves an unknown suffix after a child-owned boolean short flag", async () => {
    const root = new Command().name("openclaw");
    const browser = root.command("browser").option("-p, --browser-profile <name>");
    const extension = browser.command("extension");
    const pair = extension.command("pair").option("-p, --preview");

    const parsed = pair.parseOptions(["-pfoo"]);

    expect(parsed.unknown).toEqual(["-foo"]);
    expect(pair.opts()).toEqual({ preview: true });

    const argv = ["node", "openclaw", "browser", "extension", "pair", "-pfoo"];
    await expectReparseArgv({ parent: browser, action: extension, argv, expected: argv });
  });

  it("preserves child-owned short groups with an optional separate value", async () => {
    const root = new Command().name("openclaw");
    const browser = root.command("browser").option("-p, --browser-profile <name>");
    const extension = browser.command("extension");
    const pair = extension.command("pair").option("-p, --preview").option("-r, --retry [value]");

    const parsed = pair.parseOptions(["-pr", "remote"]);

    expect(parsed.unknown).toEqual([]);
    expect(pair.opts()).toEqual({ preview: true, retry: "remote" });

    const argv = ["node", "openclaw", "browser", "extension", "pair", "-pr", "remote"];
    await expectReparseArgv({ parent: browser, action: extension, argv, expected: argv });
  });

  it("rejects a missing parent option value before loading the lazy command", async () => {
    const root = new Command().name("openclaw").exitOverride();
    const browser = root.command("browser").option("--browser-profile <name>");
    const register = vi.fn();
    registerCommandGroups(
      browser,
      [{ placeholders: [{ name: "tabs", description: "Browser tabs" }], register }],
      { eager: false, primary: null, registerPrimaryOnly: false },
    );
    const argv = ["node", "openclaw", "browser", "tabs", "--browser-profile"];
    await expect(root.parseAsync(argv)).rejects.toMatchObject({
      code: "commander.optionMissingArgument",
    });
    expect(register).not.toHaveBeenCalled();
  });
});
