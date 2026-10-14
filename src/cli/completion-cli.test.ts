// Completion CLI tests cover shell completion command generation and install output.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command, Option } from "commander";
import { afterAll, describe, expect, it } from "vitest";
import { getCompletionScript } from "./completion-cli.js";
import {
  createAliasedCompletionProgram,
  createCompletionProgram,
  createDocumentedCompletionProgram,
  itWithFish,
  itWithPowerShell,
  PowerShellCompletionRunner,
  runGeneratedBashCompletion,
  runGeneratedFishCompletion,
} from "./completion-cli.test-support.js";
import { registerModelsCli } from "./models-cli.js";

const powerShellCompletion = new PowerShellCompletionRunner();

afterAll(async () => {
  await powerShellCompletion.close();
});

function createOptionalChoiceCompletionProgram(): Command {
  const program = new Command().name("openclaw");
  program.addOption(new Option("--mode [mode]", "Mode").choices(["auto", "manual", "-legacy"]));
  program.option("--json", "JSON output");
  return program;
}

describe("completion-cli", () => {
  it("escapes zsh option descriptions for double-quoted arguments specs", () => {
    const program = new Command()
      .name("openclaw")
      .option("--literal", "Use $OPENCLAW_STATE_DIR with `model/list` and John's profile");

    const script = getCompletionScript("zsh", program);

    expect(script).toContain(
      "--literal[Use \\$OPENCLAW_STATE_DIR with \\`model/list\\` and John's profile]",
    );
    expect(script).not.toContain("John'\\''s");
  });

  it.skipIf(process.platform === "win32").each(["built-in", "root"] as const)(
    "keeps %s command descriptions literal through real zsh parsing",
    (scope) => {
      const program = new Command().name("openclaw");
      let describedCommand: Command;
      let completionFunction: string;
      if (scope === "built-in") {
        registerModelsCli(program);
        const auth = program.commands
          .find((command) => command.name() === "models")
          ?.commands.find((command) => command.name() === "auth");
        const logout = auth?.commands.find((command) => command.name() === "logout");
        if (!logout) {
          throw new Error("Models auth logout command is unavailable");
        }
        describedCommand = logout;
        completionFunction = "_openclaw_models_auth";
      } else {
        describedCommand = program
          .command("inspect")
          .alias("review")
          .description(
            'Show John\'s "literal" $OPENCLAW_COMPLETION_LITERAL with `models auth list`',
          );
        completionFunction = "_openclaw_root_completion";
      }

      const result = spawnSync(
        "zsh",
        [
          "-fc",
          `${getCompletionScript("zsh", program)}
OPENCLAW_COMPLETION_LITERAL=expanded-value
models() { printf '%s\\n' "OPENCLAW_COMPLETION_DESCRIPTION_EVALUATED:$*" >&2; }
_arguments() {
  local spec
  for spec in "$@"; do
    if [[ "$spec" == "1: :"* ]]; then
      local -a action
      eval "action=( \${spec#1: :} )"
      printf '%s\\0' "\${action[@]}"
    fi
  done
}
${completionFunction}
`,
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
      if (result.error) {
        if ("code" in result.error && result.error.code === "ENOENT") {
          return;
        }
        throw result.error;
      }

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const action = result.stdout.split("\0").filter(Boolean);
      expect(action.slice(0, 2)).toEqual(["_values", "command"]);
      for (const name of [describedCommand.name(), ...describedCommand.aliases()]) {
        expect(action).toContain(`${name}[${describedCommand.description()}]`);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps zsh completion choices literal and preserves candidate boundaries",
    () => {
      const program = new Command().name("openclaw");
      program.addOption(
        new Option("--value <value>", "Value").choices([
          "two words",
          'say "hello"',
          "it's literal",
          "literal $(printf OPENCLAW_COMPLETION_VALUE_EXECUTED >&2)",
          "literal `printf OPENCLAW_COMPLETION_VALUE_EXECUTED >&2`",
        ]),
      );

      const result = spawnSync(
        "zsh",
        [
          "-fc",
          `${getCompletionScript("zsh", program)}
_arguments() { printf '%s\\n' "$@"; }
_openclaw_root_completion
`,
        ],
        { encoding: "utf8" },
      );
      if (result.error) {
        if ("code" in result.error && result.error.code === "ENOENT") {
          return;
        }
        throw result.error;
      }

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("two\\ words");
      expect(result.stdout).toContain('say\\ \\"hello\\"');
      expect(result.stdout).toContain("OPENCLAW_COMPLETION_VALUE_EXECUTED");
    },
  );

  it("defers zsh registration until compinit is available", async () => {
    if (process.platform === "win32") {
      return;
    }

    const probe = spawnSync("zsh", ["-fc", "exit 0"], { encoding: "utf8" });
    if (probe.error) {
      if (
        "code" in probe.error &&
        (probe.error.code === "ENOENT" || probe.error.code === "EACCES")
      ) {
        return;
      }
      throw probe.error;
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-zsh-completion-"));
    try {
      const scriptPath = path.join(tempDir, "openclaw.zsh");
      await fs.writeFile(scriptPath, getCompletionScript("zsh", createCompletionProgram()), "utf8");

      const result = spawnSync(
        "zsh",
        [
          "-fc",
          `
            source ${JSON.stringify(scriptPath)}
            [[ -z "\${_comps[openclaw]-}" ]] || exit 10
            [[ "\${precmd_functions[(r)_openclaw_register_completion]}" = "_openclaw_register_completion" ]] || exit 11
            autoload -Uz compinit
            compinit -C
            _openclaw_register_completion
            [[ -z "\${precmd_functions[(r)_openclaw_register_completion]}" ]] || exit 12
            [[ "\${_comps[openclaw]-}" = "_openclaw_root_completion" ]]
          `,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: tempDir,
            ZDOTDIR: tempDir,
          },
        },
      );

      expect(result.stderr).not.toContain("command not found: compdef");
      expect(result.status).toBe(0);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  itWithPowerShell.each([
    {
      name: "an option after a shell value",
      prefix: "openclaw completion --shell f",
      suffix: " --yes",
      expected: ["fish"],
    },
  ])(
    "ignores real PowerShell words after the cursor: $name",
    async ({ prefix, suffix, expected }) => {
      const program = createDocumentedCompletionProgram();
      program.command("status").description("Root status").option("--json", "JSON output");

      expect(
        await powerShellCompletion.complete(program, `${prefix}${suffix}`, prefix.length),
      ).toEqual(expected);
    },
  );

  itWithPowerShell.each([
    {
      name: "an omitted optional value",
      commandLine: "openclaw --mode --j",
      expected: ["--json"],
    },
    {
      name: "a hyphen-prefixed optional choice",
      commandLine: "openclaw --mode -l",
      expected: ["-legacy"],
    },
  ])("preserves real PowerShell completion after $name", async ({ commandLine, expected }) => {
    expect(
      await powerShellCompletion.complete(createOptionalChoiceCompletionProgram(), commandLine),
    ).toEqual(expected);
  });

  itWithPowerShell.each([
    ["a case-insensitive literal asterisk", "openclaw --value A*", ["'a*literal'"]],
  ])("matches real PowerShell choices with %s", async (_name, commandLine, expected) => {
    const program = new Command().name("openclaw");
    program.addOption(
      new Option("--value <value>", "Value").choices(["alpha", "a*literal", "a[bracket]"]),
    );

    expect(await powerShellCompletion.complete(program, commandLine)).toEqual(expected);
  });

  itWithPowerShell.each([
    ["apostrophes", "Jane's", "Ja"],
    [
      "literal command substitution",
      "literal $(Write-Error OPENCLAW_COMPLETION_VALUE_EXECUTED)",
      "literal",
    ],
  ])("inserts PowerShell %s as one safe argument", async (_name, value, prefix) => {
    const program = new Command().name("openclaw");
    program.addOption(new Option("--value <value>", "Value").choices([value]));
    const safeValue = /^[A-Za-z0-9_./:+-]+$/.test(value)
      ? value
      : `'${value.replaceAll("'", "''")}'`;

    expect(await powerShellCompletion.complete(program, `openclaw --value ${prefix}`)).toEqual([
      safeValue,
    ]);
    expect(await powerShellCompletion.complete(program, `openclaw --value=${prefix}`)).toEqual([
      `--value=${safeValue}`,
    ]);
  });

  itWithFish.each([
    [
      "mixed value-taking root options",
      "openclaw --profile work --log-level debug --container local g",
    ],
  ])("completes root commands in real Fish after %s", (_name, commandLine) => {
    const program = createCompletionProgram()
      .option("-p, --profile <name>", "Profile")
      .option("--log-level <level>", "Log level")
      .option("--container <name>", "Container");

    expect(runGeneratedFishCompletion(program, commandLine)).toContain("gateway");
  });

  itWithFish.each([["an inline short option value", "openclaw gateway -t=secret status -"]])(
    "keeps real Fish completions scoped after %s",
    (_name, commandLine) => {
      expect(runGeneratedFishCompletion(createCompletionProgram(), commandLine)).toEqual([
        "--json",
      ]);
    },
  );

  itWithFish.each([
    ["a positional argument named like a sibling", "openclaw gateway status restart -"],
  ])("keeps real Fish leaf options after %s", (_name, commandLine) => {
    const program = createCompletionProgram();
    const gateway = program.commands.find((command) => command.name() === "gateway");
    const status = gateway?.commands.find((command) => command.name() === "status");
    if (!status) {
      throw new Error("Gateway status command is unavailable");
    }
    status.argument("[query...]", "Search query");

    expect(runGeneratedFishCompletion(program, commandLine)).toEqual(["--json"]);
  });

  itWithFish.each([["a separated long optional value", "openclaw --color a", "always"]])(
    "completes real Fish Commander choices after %s",
    (_name, commandLine, expected) => {
      const program = new Command()
        .name("openclaw")
        .addOption(new Option("-c, --color [when]").choices(["always", "never"]));

      expect(runGeneratedFishCompletion(program, commandLine)).toContain(expected);
    },
  );

  itWithFish.each([
    ["apostrophes", "it's literal", "it"],
    [
      "literal command substitution",
      "literal $(printf OPENCLAW_COMPLETION_VALUE_EXECUTED >&2)",
      "literal",
    ],
  ])("preserves Fish choice %s as one inert candidate", (_name, value, prefix) => {
    const program = new Command().name("openclaw");
    program.addOption(new Option("--value <value>", "Value").choices([value]));

    expect(runGeneratedFishCompletion(program, `openclaw --value ${prefix}`)).toEqual([value]);
  });

  it("does not require optional Fish option choices", () => {
    const program = new Command().name("openclaw");
    program.addOption(new Option("--mode [mode]", "Mode").choices(["auto", "manual"]));

    const optionLine = getCompletionScript("fish", program)
      .split("\n")
      .find((line) => line.includes(" -l mode "));

    expect(optionLine).toContain(" -f -a ");
    expect(optionLine).not.toContain(" -r ");
    expect(optionLine).toContain("'auto' 'manual'");
  });

  it("uses Commander's parsed flags instead of value placeholder syntax", () => {
    const program = new Command()
      .name("openclaw")
      .option("--trigger-script <path|->", "Condition script file, or - for stdin")
      .option("--ws, --workspace <name>", "Workspace");

    const fishScript = getCompletionScript("fish", program);

    expect(fishScript).toContain(
      "complete -c openclaw -n \"__openclaw_command_path_matches\" -l trigger-script -r -d 'Condition script file, or - for stdin'",
    );
    expect(fishScript).not.toContain(" -s > ");
    expect(fishScript).toContain(" -l ws -l workspace -r -d 'Workspace'");
    expect(getCompletionScript("bash", program)).not.toContain("--trigger-script ->");
    expect(getCompletionScript("zsh", program)).not.toContain("{--trigger-script,->}");
  });

  it.skipIf(process.platform === "win32").each([
    ["an omitted optional value", ["openclaw", "--mode", "--j"], ["--json"]],
    ["a hyphen-prefixed optional choice", ["openclaw", "--mode", "-l"], ["-legacy"]],
  ])("preserves real Bash completion after %s", (_name, words, expected) => {
    expect(runGeneratedBashCompletion(createOptionalChoiceCompletionProgram(), words)).toEqual(
      expected,
    );
  });

  it.skipIf(process.platform === "win32").each([
    ["apostrophes", "it's literal", "it\\'s"],
    ["literal command substitution", "$(printf OPENCLAW_COMPLETION_VALUE_EXECUTED >&2)", "$("],
  ])("keeps Bash choice %s literal without executing it", (_name, value, prefix) => {
    const program = new Command().name("openclaw");
    program.addOption(new Option("--value <value>", "Value").choices([value]));

    expect(runGeneratedBashCompletion(program, ["openclaw", "--value", prefix])).toEqual([value]);
    expect(runGeneratedBashCompletion(program, ["openclaw", `--value=${prefix}`])).toEqual([
      `--value=${value}`,
    ]);
  });

  it
    .skipIf(process.platform === "win32")
    .each([
      [
        "an inline inherited parent option",
        ["openclaw", "cron", "create", "--channel=pre"],
        ["--channel=preview"],
      ],
    ])("uses the nearest validated Bash choices for %s", (_name, words, expected) => {
    const program = createAliasedCompletionProgram();
    program.addOption(
      new Option("--channel <channel>", "Update channel").choices(["stable", "beta"]),
    );
    const cron = program.commands.find((command) => command.name() === "cron");
    if (!cron) {
      throw new Error("Cron command is unavailable");
    }
    cron.addOption(
      new Option("--channel <channel>", "Cron channel").choices(["production", "preview"]),
    );

    expect(runGeneratedBashCompletion(program, words)).toEqual(expected);
  });

  it.skipIf(process.platform === "win32")(
    "preserves pending short-cluster choices that start with a hyphen in real Bash",
    () => {
      const program = new Command()
        .name("openclaw")
        .option("-v, --verbose", "Verbose output")
        .addOption(new Option("-m, --mode <mode>").choices(["-legacy"]))
        .exitOverride();

      program.parse(["-vm", "-legacy"], { from: "user" });
      expect(program.opts()).toEqual({ verbose: true, mode: "-legacy" });
      expect(runGeneratedBashCompletion(program, ["openclaw", "-vm", "-le"])).toEqual(["-legacy"]);
    },
  );

  itWithPowerShell.each([
    ["a short-option cluster value", "openclaw completion -ysf", "-ysfish"],
    ["a separated short-option cluster value", "openclaw completion -ys f", "fish"],
  ])("completes PowerShell Commander choices after %s", async (_name, commandLine, expected) => {
    expect(
      await powerShellCompletion.complete(createDocumentedCompletionProgram(), commandLine),
    ).toEqual([expected]);
  });
});
