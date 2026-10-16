// Action reparse tests cover Commander action reparsing for nested CLI commands.
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { reparseProgramFromActionCommand } from "./action-reparse.js";
import { registerCommandGroups } from "./register-command-groups.js";

function setRawArgs(command: Command, rawArgs: string[]): void {
  (command as Command & { rawArgs: string[] }).rawArgs = rawArgs;
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
  const parseAsync = vi.spyOn(root, "parseAsync").mockResolvedValue(root);

  await reparseProgramFromActionCommand(params.parent, params.action);

  expect(parseAsync).toHaveBeenCalledWith(params.expected);
}

describe("reparseProgramFromActionCommand", () => {
  it.each([{ args: ["config", "get", "--", "--help"] }])(
    "keeps literal flag-looking values through actual lazy reparse: $args",
    async ({ args }) => {
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
      await program.parseAsync(["node", "openclaw", ...args]);
      expect(received).toEqual(["--help"]);
    },
  );

  it("uses root raw args and reparses the root for nested lazy commands", async () => {
    const root = new Command().name("openclaw");
    setRawArgs(root, ["node", "openclaw", "workspaces", "audit", "export", "--since", "1"]);
    const workspaces = root.command("workspaces");
    const audit = workspaces.command("audit");
    const exportCommand = audit.command("export");
    const parseAsync = vi.spyOn(root, "parseAsync").mockResolvedValue(root);
    const auditParseAsync = vi.spyOn(audit, "parseAsync");

    await reparseProgramFromActionCommand(audit, exportCommand);

    expect(parseAsync).toHaveBeenCalledWith([
      "node",
      "openclaw",
      "workspaces",
      "audit",
      "export",
      "--since",
      "1",
    ]);
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

  it.each([
    {
      label: "an optional separate value",
      retryFlags: "-r, --retry [value]",
      tokens: ["-pr", "remote"],
      expected: { preview: true, retry: "remote" },
    },
  ] as const)(
    "preserves child-owned short groups with $label",
    async ({ retryFlags, tokens, expected }) => {
      const root = new Command().name("openclaw");
      const browser = root.command("browser").option("-p, --browser-profile <name>");
      const extension = browser.command("extension");
      const pair = extension.command("pair").option("-p, --preview").option(retryFlags);

      const parsed = pair.parseOptions([...tokens]);

      expect(parsed.unknown).toEqual([]);
      expect(pair.opts()).toEqual(expected);

      const argv = ["node", "openclaw", "browser", "extension", "pair", ...tokens];
      await expectReparseArgv({ parent: browser, action: extension, argv, expected: argv });
    },
  );

  it("keeps a missing parent option value after the loaded command", async () => {
    const root = new Command().name("openclaw");
    const browser = root.command("browser").option("--browser-profile <name>");
    const tabs = browser.command("tabs");
    const argv = ["node", "openclaw", "browser", "tabs", "--browser-profile"];
    await expectReparseArgv({ parent: browser, action: tabs, argv, expected: argv });
  });
});
