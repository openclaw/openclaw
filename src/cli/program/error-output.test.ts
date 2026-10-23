import { CommanderError, InvalidArgumentError, type Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isConfigMachineOutput } from "../config-output-mode.js";
import { createCronOutputCommand, isCronMachineOutput } from "../cron-cli/output-mode.js";
import { isDevicesMachineOutput } from "../devices-output-mode.js";
import { ExpectedCliError, formatCliJsonFailure } from "../failure-output.js";
import {
  isJsonOutputModeActive,
  withConsoleLogsRoutedToStderrForJson,
} from "../json-output-mode.js";
import { isNodesMachineOutput } from "../nodes-cli/output-mode.js";
import { isProxyMachineOutput } from "../proxy-output-mode.js";
import { isSkillsMachineOutput } from "../skills-output-mode.js";
import { isSystemMachineOutput } from "../system-output-mode.js";
import {
  getCommanderErrorCommandNames,
  getCommanderErrorCommandPath,
} from "./commander-parse-facts.js";
import {
  createCliParseError,
  createCliUnknownCommandError,
  formatCliParseErrorOutput,
} from "./error-output.js";
import { setCommandJsonMode } from "./json-mode.js";
import { OpenClawCommand } from "./openclaw-command.js";
import { registerCommandGroups } from "./register-command-groups.js";

let originalArgv: string[];
beforeEach(() => {
  originalArgv = process.argv;
});
afterEach(() => {
  process.argv = originalArgv;
  vi.unstubAllEnvs();
});

function makeProgram(args: readonly string[], positional = false) {
  process.argv = ["node", "openclaw", ...args];
  const program = new OpenClawCommand()
    .name("openclaw")
    .enablePositionalOptions(positional)
    .exitOverride();
  program.configureOutput({ writeErr: () => {} });
  return program;
}

async function parseFailure(
  program: Command,
  check: (error: unknown) => void,
  machineOutput?: boolean,
) {
  return withConsoleLogsRoutedToStderrForJson(
    process.argv,
    async () => {
      check(await program.parseAsync(process.argv).catch((cause: unknown) => cause));
    },
    { machineOutput, restoreChanges: true },
  );
}

async function parseLazyGroupError(
  argv: string[],
  subcommands = ["list", "cleanup"],
): Promise<{ error: CommanderError; output: string; stdout: string }> {
  process.argv = ["node", "openclaw", ...argv];
  let output = "";
  let stdout = "";
  const program = new OpenClawCommand().name("openclaw").exitOverride();
  program.configureOutput({
    writeOut: (value) => {
      stdout += value;
    },
    writeErr: (value) => {
      output += value;
    },
    outputError: (value, write) => {
      write(
        formatCliParseErrorOutput(value, {
          argv: process.argv,
          commandPath: getCommanderErrorCommandPath(program),
          commandNames: getCommanderErrorCommandNames(program),
        }),
      );
    },
  });
  registerCommandGroups(
    program,
    [
      {
        placeholders: [{ name: "sessions", description: "sessions commands" }],
        register: () => {
          const group = program.command("sessions").action(() => {});
          for (const name of subcommands) {
            group.command(name).action(() => {});
          }
        },
      },
    ],
    { eager: false, primary: null, registerPrimaryOnly: false },
  );

  const error = await program.parseAsync(process.argv).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(CommanderError);
  return { error: error as CommanderError, output, stdout };
}

describe("formatCliParseErrorOutput", () => {
  it.each([
    ["cron scratch", "<id>", 'Missing required argument "id".', isCronMachineOutput],
    ["skills verify", "<ref>", 'Missing required argument "ref".', isSkillsMachineOutput],
    ["skills -- verify", "<ref>", 'Missing required argument "ref".', isSkillsMachineOutput],
    ["config -- get", "<path>", 'Missing required argument "path".', isConfigMachineOutput],
    [
      "nodes approve",
      "<requestId>",
      'Missing required argument "requestId".',
      isNodesMachineOutput,
    ],
    [
      "devices rotate",
      "--device <id>",
      'Missing required option "--device <id>".',
      isDevicesMachineOutput,
    ],
    ["proxy blob", "<blobId>", 'Missing required argument "blobId".', isProxyMachineOutput],
    [
      "system heartbeat last --unknown",
      "",
      'OpenClaw does not recognize option "--unknown".',
      isSystemMachineOutput,
    ],
  ] as const)(
    "keeps %s parse failures machine-readable by default",
    async (args, required, message, machineOutput) => {
      const program = makeProgram(args.split(" "), true).option("--profile <name>");
      const [name, ...children] = args.split(" ").filter((arg) => !arg.startsWith("--"));
      const root = program.command(name!);
      setCommandJsonMode(root, "output", ({ argv, command }) => machineOutput(argv, command));
      let command = root;
      for (const child of children) {
        command =
          name === "cron"
            ? createCronOutputCommand(command, "scratch")
            : command.command(child).option("--json");
      }
      if (required.startsWith("--")) {
        command.requiredOption(required);
      } else if (required) {
        command.argument(required);
      }
      command.action(() => {});
      await parseFailure(
        program,
        (error) => {
          expect(error).toBeInstanceOf(ExpectedCliError);
          expect(isJsonOutputModeActive(process.argv)).toBe(true);
          expect(formatCliJsonFailure(error)).toEqual({
            ok: false,
            error: { type: "cli_error", message: expect.stringContaining(message) },
          });
        },
        machineOutput(process.argv),
      );
    },
  );

  it("keeps a consumed JSON spelling machine-readable when the command owns JSON by default", async () => {
    const program = makeProgram(["cron", "status", "--limit", "--json"]);
    const cron = program.command("cron");
    setCommandJsonMode(cron, "output", ({ argv }) => isCronMachineOutput(argv));
    createCronOutputCommand(cron, "status")
      .option("--limit <value>", "Result limit", () => {
        throw new InvalidArgumentError("--limit must be a positive integer.");
      })
      .action(() => {});

    await parseFailure(
      program,
      (error) => {
        expect(error).toBeInstanceOf(ExpectedCliError);
        expect(isJsonOutputModeActive(process.argv)).toBe(true);
        expect((error as ExpectedCliError).message).toContain(
          "--limit must be a positive integer.",
        );
      },
      true,
    );
  });

  it.each(["config set gateway.port --json", "skills verify --card"])(
    "keeps %s parse failures on the human error path",
    async (args) => {
      const [name, child] = args.split(" ");
      const program = makeProgram(args.split(" "));
      const root = program.command(name!);
      if (name === "skills") {
        setCommandJsonMode(root, "output", ({ argv }) => isSkillsMachineOutput(argv));
      }
      const command = root.command(child!).argument("<id>").option("--json");
      if (name === "config") {
        command.argument("<value>");
        setCommandJsonMode(command, "parse-only", () => true);
      } else if (name === "skills") {
        command.option("--card");
      }
      command.action(() => {});

      await parseFailure(program, (error) => {
        expect(error).toBeInstanceOf(CommanderError);
        expect(error).not.toBeInstanceOf(ExpectedCliError);
        expect(isJsonOutputModeActive(process.argv)).toBe(false);
      });
    },
  );

  it("uses the same structured root diagnostic as the human renderer", () => {
    const error = createCliUnknownCommandError("pairng", {
      argv: ["node", "openclaw", "pairng", "--json"],
    });

    expect(error).toMatchObject({
      message: 'OpenClaw does not know the command "pairng".',
      humanOutput:
        'OpenClaw does not know the command "pairng".\nDid you mean this?\n  openclaw pairing\nTry: openclaw --help\nPlugin command? openclaw plugins list\nDocs: https://docs.openclaw.ai/cli\n',
    });
  });

  it("strips Commander framing from structured nested diagnostics", () => {
    const error = createCliParseError("error: unknown command 'lst'", {
      argv: ["node", "openclaw", "sessions", "lst", "--json"],
      commandPath: ["sessions"],
      commandNames: ["list"],
    });

    expect(error.message).toBe('OpenClaw sessions has no command "lst".');
    expect(error.humanOutput).toContain("Did you mean this?\n  openclaw sessions list\n");
  });

  it.each([
    [
      "unknown command 'list'",
      "webhooks list",
      ["webhooks"],
      'OpenClaw webhooks has no command "list".\nTry: openclaw webhooks --help\nDocs: https://docs.openclaw.ai/cli\n',
    ],
    [
      "unknown option '--wat'",
      "channels status --wat",
      undefined,
      'OpenClaw does not recognize option "--wat".\nTry: openclaw channels status --help\n',
    ],
  ] as const)("renders %s within the active command tree", (raw, args, commandPath, expected) => {
    expect(
      formatCliParseErrorOutput(`error: ${raw}\n`, {
        argv: ["node", "openclaw", ...args.split(" ")],
        commandPath: commandPath ? [...commandPath] : undefined,
      }),
    ).toBe(expected);
  });

  it.each([false, true])("reports an unmatched lazy subcommand with help=%s", async (help) => {
    const { error, output, stdout } = await parseLazyGroupError([
      "sessions",
      "lst",
      ...(help ? ["--help"] : []),
    ]);

    expect(error).toMatchObject({ code: "commander.unknownCommand", exitCode: 1 });
    expect(stdout).toBe("");
    expect(output).toBe(
      'OpenClaw sessions has no command "lst".\nDid you mean this?\n  openclaw sessions list\nTry: openclaw sessions --help\nDocs: https://docs.openclaw.ai/cli\n',
    );
  });

  it("keeps excess arguments on a matched lazy subcommand", async () => {
    const { error, output } = await parseLazyGroupError(
      ["sessions", "list", "extra1", "extra2"],
      ["list"],
    );

    expect(error.code).toBe("commander.excessArguments");
    expect(output).toBe(
      "Too many arguments for this command.\nTry: openclaw sessions list --help\n",
    );
  });

  it.each([
    ["upgrade", undefined, "openclaw update"],
    ["doctr", "work", "openclaw --profile work doctor"],
  ])("suggests commands for %s with profile=%s", (input, profile, command) => {
    if (profile) {
      vi.stubEnv("OPENCLAW_PROFILE", profile);
    }
    expect(
      formatCliParseErrorOutput(`error: unknown command '${input}'\n`, {
        argv: ["node", "openclaw", input],
      }),
    ).toContain(`Did you mean this?\n  ${command}\n`);
  });
});
