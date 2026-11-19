import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { removeCommandByName } from "./command-tree.js";
import { registerCommandGroups } from "./register-command-groups.js";

function registerLazy(parent: Command, name: string, register: () => void) {
  const placeholder = { name, description: "Lazy test command" };
  registerCommandGroups(parent, [{ placeholders: [placeholder], register }], {
    eager: false,
    primary: null,
    registerPrimaryOnly: false,
  });
}

async function expectReparseArgv(parent: Command, action: Command, args: string, expected = args) {
  let root = parent;
  while (root.parent) {
    root = root.parent;
  }
  removeCommandByName(parent, action.name());
  registerLazy(parent, action.name(), () => {
    parent.addCommand(action);
  });
  const parse = root.parseAsync.bind(root);
  const parseAsync = vi.spyOn(root, "parseAsync").mockResolvedValue(root);
  parseAsync.mockImplementationOnce(parse);

  await root.parseAsync(["node", "openclaw", ...args.split(" ")]);
  expect(parseAsync).toHaveBeenCalledTimes(2);
  expect(parseAsync).toHaveBeenLastCalledWith(["node", "openclaw", ...expected.split(" ")]);
}

describe("lazy command action reparsing", () => {
  it("keeps literal flag-looking values through actual lazy reparse", async () => {
    const program = new Command().name("openclaw").enablePositionalOptions();
    const received: string[] = [];
    registerLazy(program, "config", () => {
      program
        .command("config")
        .command("get")
        .argument("<path>")
        .action((value: string) => {
          received.push(value);
        });
    });
    await program.parseAsync(["node", "openclaw", "config", "get", "--", "--help"]);
    expect(received).toEqual(["--help"]);
  });

  it("uses root raw args and reparses the root for nested lazy commands", async () => {
    const root = new Command().name("openclaw");
    const audit = root.command("workspaces").command("audit");
    const exportCommand = audit.command("export");
    const auditParseAsync = vi.spyOn(audit, "parseAsync");

    await expectReparseArgv(audit, exportCommand, "workspaces audit export --since 1");
    expect(auditParseAsync).not.toHaveBeenCalled();
  });

  it("skips an attached root option value that matches the parent command name", async () => {
    const root = new Command().name("openclaw").option("-p, --profile <name>");
    const browser = root.command("browser").option("--browser-profile <name>");
    await expectReparseArgv(
      browser,
      browser.command("tabs"),
      "-pbrowser browser tabs --browser-profile remote",
      "-pbrowser browser --browser-profile remote tabs",
    );
  });

  it.each([
    ["--json", { json: true }, []],
    ["-pfoo", { preview: true }, ["-foo"]],
    ["-pr remote", { preview: true, retry: "remote" }, []],
  ] as const)("preserves child-owned options %s", async (args, options, unknown) => {
    const json = args === "--json";
    const browser = new Command()
      .name("openclaw")
      .command("browser")
      .option(json ? "--json" : "-p, --browser-profile <name>");
    const extension = browser.command("extension");
    extension.command("path");
    const pair = extension.command("pair").option(json ? "--json" : "-p, --preview");
    if (args === "-pr remote") {
      pair.option("-r, --retry [value]");
    }
    expect(pair.parseOptions(args.split(" ")).unknown).toEqual(unknown);
    expect(pair.opts()).toEqual(options);
    await expectReparseArgv(browser, extension, `browser extension pair ${args}`);
  });

  it("rejects a missing parent option value before loading the lazy command", async () => {
    const root = new Command().name("openclaw").exitOverride();
    const browser = root.command("browser").option("--browser-profile <name>");
    const register = vi.fn();
    registerLazy(browser, "tabs", register);
    const argv = ["node", "openclaw", "browser", "tabs", "--browser-profile"];
    await expect(root.parseAsync(argv)).rejects.toMatchObject({
      code: "commander.optionMissingArgument",
    });
    expect(register).not.toHaveBeenCalled();
  });
});
