// Error output tests cover program-level error display and exit messaging.
import { CommanderError, InvalidArgumentError, type Command } from "commander";
import { describe, expect, it } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
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

async function parseLazyGroupError(params: {
  argv: string[];
  group: string;
  subcommands: Array<{ name: string; aliases?: string[] }>;
}): Promise<{ error: CommanderError; output: string; stdout: string }> {
  const originalArgv = process.argv;
  process.argv = ["node", "openclaw", ...params.argv];
  let output = "";
  let stdout = "";
  try {
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
          placeholders: [{ name: params.group, description: `${params.group} commands` }],
          register: () => {
            const group = program.command(params.group).action(() => {});
            for (const subcommand of params.subcommands) {
              const command = group.command(subcommand.name).action(() => {});
              for (const alias of subcommand.aliases ?? []) {
                command.alias(alias);
              }
            }
          },
        },
      ],
      { eager: false, primary: null, registerPrimaryOnly: false },
    );

    const error = await program.parseAsync(process.argv).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CommanderError);
    return { error: error as CommanderError, output, stdout };
  } finally {
    process.argv = originalArgv;
  }
}

describe("formatCliParseErrorOutput", () => {
  it.each<{
    name: string;
    args: string[];
    root: string;
    children: string[];
    argument?: string;
    requiredOption?: string;
    message: string;
    machineOutput: (argv: readonly string[], command?: Command) => boolean;
  }>([
    {
      name: "raw automation scratch",
      args: ["cron", "scratch"],
      root: "cron",
      children: ["scratch"],
      argument: "<id>",
      message: 'Missing required argument "id".',
      machineOutput: isCronMachineOutput,
    },
    {
      name: "skill verification",
      args: ["skills", "verify"],
      root: "skills",
      children: ["verify"],
      argument: "<ref>",
      message: 'Missing required argument "ref".',
      machineOutput: isSkillsMachineOutput,
    },
    {
      name: "skill verification after a parent terminator",
      args: ["skills", "--", "verify"],
      root: "skills",
      children: ["verify"],
      argument: "<ref>",
      message: 'Missing required argument "ref".',
      machineOutput: isSkillsMachineOutput,
    },
    {
      name: "config read after a parent terminator",
      args: ["config", "--", "get"],
      root: "config",
      children: ["get"],
      argument: "<path>",
      message: 'Missing required argument "path".',
      machineOutput: isConfigMachineOutput,
    },
    {
      name: "node approval",
      args: ["nodes", "approve"],
      root: "nodes",
      children: ["approve"],
      argument: "<requestId>",
      message: 'Missing required argument "requestId".',
      machineOutput: isNodesMachineOutput,
    },
    {
      name: "device rotation",
      args: ["devices", "rotate"],
      root: "devices",
      children: ["rotate"],
      requiredOption: "--device <id>",
      message: 'Missing required option "--device <id>".',
      machineOutput: isDevicesMachineOutput,
    },
    {
      name: "raw proxy blob",
      args: ["proxy", "blob"],
      root: "proxy",
      children: ["blob"],
      argument: "<blobId>",
      message: 'Missing required argument "blobId".',
      machineOutput: isProxyMachineOutput,
    },
    {
      name: "nested system heartbeat",
      args: ["system", "heartbeat", "last", "--unknown"],
      root: "system",
      children: ["heartbeat", "last"],
      message: 'OpenClaw does not recognize option "--unknown".',
      machineOutput: isSystemMachineOutput,
    },
  ])("keeps $name parse failures machine-readable by default", async (testCase) => {
    const originalArgv = process.argv;
    process.argv = ["node", "openclaw", ...testCase.args];
    try {
      const program = new OpenClawCommand()
        .name("openclaw")
        .enablePositionalOptions()
        .option("--profile <name>")
        .exitOverride();
      program.configureOutput({ writeErr: () => {} });
      const root = program.command(testCase.root);
      setCommandJsonMode(root, "output", ({ argv, command }) =>
        testCase.machineOutput(argv, command),
      );

      let command = root;
      for (const child of testCase.children) {
        command =
          testCase.root === "cron"
            ? createCronOutputCommand(command, child as "get" | "runs" | "scratch")
            : command.command(child).option("--json");
      }
      if (testCase.argument) {
        command.argument(testCase.argument);
      }
      if (testCase.requiredOption) {
        command.requiredOption(testCase.requiredOption);
      }
      command.action(() => {});

      await withConsoleLogsRoutedToStderrForJson(
        process.argv,
        async () => {
          const error = await program.parseAsync(process.argv).catch((cause: unknown) => cause);

          expect(error).toBeInstanceOf(ExpectedCliError);
          expect(isJsonOutputModeActive(process.argv)).toBe(true);
          expect(formatCliJsonFailure(error)).toEqual({
            ok: false,
            error: {
              type: "cli_error",
              message: expect.stringContaining(testCase.message),
            },
          });
        },
        { machineOutput: testCase.machineOutput(process.argv), restoreChanges: true },
      );
    } finally {
      process.argv = originalArgv;
    }
  });

  it("keeps a consumed JSON spelling machine-readable when the command owns JSON by default", async () => {
    const originalArgv = process.argv;
    process.argv = ["node", "openclaw", "cron", "status", "--limit", "--json"];
    try {
      const program = new OpenClawCommand().name("openclaw").exitOverride();
      program.configureOutput({ writeErr: () => {} });
      const cron = program.command("cron");
      setCommandJsonMode(cron, "output", ({ argv }) => isCronMachineOutput(argv));
      createCronOutputCommand(cron, "status")
        .option("--limit <value>", "Result limit", () => {
          throw new InvalidArgumentError("--limit must be a positive integer.");
        })
        .action(() => {});

      await withConsoleLogsRoutedToStderrForJson(
        process.argv,
        async () => {
          const error = await program.parseAsync(process.argv).catch((cause: unknown) => cause);

          expect(error).toBeInstanceOf(ExpectedCliError);
          expect(isJsonOutputModeActive(process.argv)).toBe(true);
          expect((error as ExpectedCliError).message).toContain(
            "--limit must be a positive integer.",
          );
        },
        { machineOutput: true, restoreChanges: true },
      );
    } finally {
      process.argv = originalArgv;
    }
  });

  it.each([
    {
      name: "parse-only config",
      args: ["config", "set", "gateway.port", "--json"],
      root: "config",
      child: "set",
    },
    {
      name: "human skill card",
      args: ["skills", "verify", "--card"],
      root: "skills",
      child: "verify",
    },
  ])("keeps $name parse failures on the human error path", async (testCase) => {
    const originalArgv = process.argv;
    process.argv = ["node", "openclaw", ...testCase.args];
    try {
      const program = new OpenClawCommand().name("openclaw").exitOverride();
      program.configureOutput({ writeErr: () => {} });
      const root = program.command(testCase.root);
      if (testCase.root === "cron") {
        setCommandJsonMode(root, "output", ({ argv }) => isCronMachineOutput(argv));
      } else if (testCase.root === "skills") {
        setCommandJsonMode(root, "output", ({ argv }) => isSkillsMachineOutput(argv));
      }
      const command = root.command(testCase.child).argument("<id>").option("--json");
      if (testCase.root === "config") {
        command.argument("<value>");
        setCommandJsonMode(command, "parse-only", () => true);
      } else if (testCase.root === "skills") {
        command.option("--card");
      }
      command.action(() => {});

      await withConsoleLogsRoutedToStderrForJson(
        process.argv,
        async () => {
          const error = await program.parseAsync(process.argv).catch((cause: unknown) => cause);

          expect(error).toBeInstanceOf(CommanderError);
          expect(error).not.toBeInstanceOf(ExpectedCliError);
          expect(isJsonOutputModeActive(process.argv)).toBe(false);
        },
        { restoreChanges: true },
      );
    } finally {
      process.argv = originalArgv;
    }
  });

  it("uses the same structured root diagnostic as the human renderer", () => {
    const error = createCliUnknownCommandError("pairng", {
      argv: ["node", "openclaw", "pairng", "--json"],
    });

    expect(error.message).toBe('OpenClaw does not know the command "pairng".');
    expect(error.humanOutput).toBe(
      'OpenClaw does not know the command "pairng".\nDid you mean this?\n  openclaw pairing\nTry: openclaw --help\nPlugin command? openclaw plugins list\nDocs: https://docs.openclaw.ai/cli\n',
    );
  });

  it("strips Commander framing from structured nested diagnostics", () => {
    const error = createCliParseError("error: unknown command 'lst'", {
      argv: ["node", "openclaw", "sessions", "lst", "--json"],
      commandPath: ["sessions"],
      commandNames: ["list"],
    });

    expect(error.message).toBe('OpenClaw sessions has no command "lst".');
    expect(error.message).not.toMatch(/^error:/i);
    expect(error.humanOutput).toContain("Did you mean this?\n  openclaw sessions list\n");
  });

  it("explains unknown subcommands within the active command tree", () => {
    const output = formatCliParseErrorOutput("error: unknown command 'list'\n", {
      argv: ["node", "openclaw", "webhooks", "list"],
      commandPath: ["webhooks"],
    });

    expect(output).toBe(
      'OpenClaw webhooks has no command "list".\nTry: openclaw webhooks --help\nDocs: https://docs.openclaw.ai/cli\n',
    );
  });

  it("reports an unmatched lazy subcommand and suggests a live child command", async () => {
    const { error, output } = await parseLazyGroupError({
      argv: ["sessions", "lst"],
      group: "sessions",
      subcommands: [{ name: "list" }, { name: "cleanup" }],
    });

    expect(error.code).toBe("commander.unknownCommand");
    expect(output).toBe(
      'OpenClaw sessions has no command "lst".\nDid you mean this?\n  openclaw sessions list\nTry: openclaw sessions --help\nDocs: https://docs.openclaw.ai/cli\n',
    );
  });

  it("reports an unmatched lazy subcommand before --help can hide it", async () => {
    const { error, output, stdout } = await parseLazyGroupError({
      argv: ["sessions", "lst", "--help"],
      group: "sessions",
      subcommands: [{ name: "list" }, { name: "cleanup" }],
    });

    expect(error.code).toBe("commander.unknownCommand");
    expect(error.exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(output).toBe(
      'OpenClaw sessions has no command "lst".\nDid you mean this?\n  openclaw sessions list\nTry: openclaw sessions --help\nDocs: https://docs.openclaw.ai/cli\n',
    );
  });

  it("keeps excess arguments on a matched lazy subcommand", async () => {
    const { error, output } = await parseLazyGroupError({
      argv: ["sessions", "list", "extra1", "extra2"],
      group: "sessions",
      subcommands: [{ name: "list" }],
    });

    expect(error.code).toBe("commander.excessArguments");
    expect(output).toBe(
      "Too many arguments for this command.\nTry: openclaw sessions list --help\n",
    );
  });

  it("suggests explicit aliases for common adjacent terminology", () => {
    const output = formatCliParseErrorOutput("error: unknown command 'upgrade'\n", {
      argv: ["node", "openclaw", "upgrade"],
    });

    expect(output).toContain("Did you mean this?\n  openclaw update\n");
  });

  it("preserves active profile context in command suggestions", () => {
    const originalEnv = captureEnv(["OPENCLAW_PROFILE"]);
    process.env.OPENCLAW_PROFILE = "work";
    try {
      const output = formatCliParseErrorOutput("error: unknown command 'doctr'\n", {
        argv: ["node", "openclaw", "doctr"],
      });

      expect(output).toContain("Did you mean this?\n  openclaw --profile work doctor\n");
    } finally {
      originalEnv.restore();
    }
  });

  it("points unknown options at the active command help", () => {
    const output = formatCliParseErrorOutput("error: unknown option '--wat'\n", {
      argv: ["node", "openclaw", "channels", "status", "--wat"],
    });

    expect(output).toBe(
      'OpenClaw does not recognize option "--wat".\nTry: openclaw channels status --help\n',
    );
  });
});
