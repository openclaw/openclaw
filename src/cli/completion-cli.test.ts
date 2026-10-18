import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { Command, Option } from "commander";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { registerAcpCli } from "./acp-cli.js";
import { getCompletionScript, registerCompletionCli } from "./completion-cli.js";
import {
  createAliasedCompletionProgram,
  createCompletionProgram,
  createDocumentedCompletionProgram as documentedProgram,
  itWithFish,
  itWithPowerShell,
  PowerShellCompletionRunner,
  runGeneratedBashCompletion as runBash,
  runGeneratedFishCompletion as runFish,
} from "./completion-cli.test-support.js";
import { registerModelsCli } from "./models-cli.js";

const powershell = new PowerShellCompletionRunner();
const itUnix = it.skipIf(process.platform === "win32");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterAll(() => powershell.close());

function optionalChoices(): Command {
  const program = choiceProgram(["auto", "manual", "-legacy"], "--mode [mode]", "Mode");
  return program.option("--json", "JSON output");
}

function choiceProgram(choices: string[], flags = "--value <value>", description = "Value") {
  return new Command().name("openclaw").addOption(new Option(flags, description).choices(choices));
}

function commandAt(program: Command, ...names: string[]): Command {
  return names.reduce((parent, name) => {
    const command = parent.commands.find((candidate) => candidate.name() === name);
    assert(command, `Missing fixture command: ${name}`);
    return command;
  }, program);
}

function runZsh(script: string, options: { timeout?: number; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync("zsh", ["-fc", script], { encoding: "utf8", ...options });
}

function runZshScript(script: string, timeout?: number): string | undefined {
  const result = runZsh(script, { timeout });
  if (result.error) {
    if ("code" in result.error && result.error.code === "ENOENT") {
      return undefined;
    }
    throw result.error;
  }
  expect(result).toMatchObject({ stderr: "", status: 0 });
  return result.stdout;
}

type NativeShell = "bash" | "fish" | "powershell";
async function complete(shell: NativeShell, program: Command, line: string) {
  return shell === "bash"
    ? runBash(program, line.split(" "))
    : shell === "fish"
      ? runFish(program, line)
      : powershell.complete(program, line);
}

const literalChoices = {
  bash: [
    ["it's literal", "it\\'s"],
    ["$(printf OPENCLAW_COMPLETION_VALUE_EXECUTED >&2)", "$("],
  ],
  fish: [
    ["it's literal", "it"],
    ["literal $(printf OPENCLAW_COMPLETION_VALUE_EXECUTED >&2)", "literal"],
  ],
  powershell: [
    ["Jane's", "Ja"],
    ["literal $(Write-Error OPENCLAW_COMPLETION_VALUE_EXECUTED)", "literal"],
  ],
} satisfies Record<NativeShell, [string, string][]>;

describe("completion-cli", () => {
  for (const [shell, nativeTest] of [
    ["bash", itUnix],
    ["fish", itWithFish],
    ["powershell", itWithPowerShell],
  ] as const) {
    nativeTest(`offers root global flags after subcommands in ${shell}`, async () => {
      const program = new Command()
        .name("openclaw")
        .enablePositionalOptions()
        .option("--profile <name>", "Profile")
        .option("--log-level <level>", "Log level")
        .option("--container <name>", "Container")
        .option("--no-color", "Disable colors")
        .option("--root-only", "Positional root option")
        .addOption(new Option("--dev", "Hidden global").hideHelp());
      const group = program.command("group").alias("g").option("--parent-only");
      group.command("status").option("--json");
      program.command("local").addOption(new Option("--profile <name>").choices(["local"]));
      for (const [line, expected] of [
        ["openclaw g status --pr", ["--profile"]],
        ["openclaw group status --no-c", ["--no-color"]],
        ["openclaw group status --log", ["--log-level"]],
        ["openclaw group status --cont", ["--container"]],
        ["openclaw group status --root", []],
        ["openclaw group status --parent", []],
        ["openclaw group status --dev", []],
        ["openclaw local --profile lo", ["local"]],
      ] as const) {
        expect(await complete(shell, program, line), line).toEqual(expected);
      }
    });

    if (shell !== "fish") {
      nativeTest.each([
        ["openclaw --mode --j", ["--json"]],
        ["openclaw --mode -l", ["-legacy"]],
      ])(`preserves optional choices in ${shell}: %s`, async (line, expected) => {
        expect(await complete(shell, optionalChoices(), line)).toEqual(expected);
      });
    }
    nativeTest.each(literalChoices[shell])(
      `keeps ${shell} choice %s inert`,
      async (value, prefix) => {
        const program = choiceProgram([value]);
        const expected = shell === "powershell" ? `'${value.replaceAll("'", "''")}'` : value;
        expect(await complete(shell, program, `openclaw --value ${prefix}`)).toEqual([expected]);
        if (shell !== "fish") {
          expect(await complete(shell, program, `openclaw --value=${prefix}`)).toEqual([
            `--value=${expected}`,
          ]);
        }
      },
    );
  }

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

  itUnix.each(["built-in", "root"] as const)("keeps %s zsh descriptions literal", (scope) => {
    const program = new Command().name("openclaw");
    let describedCommand: Command;
    let completionFunction: string;
    if (scope === "built-in") {
      registerModelsCli(program);
      describedCommand = commandAt(program, "models", "auth", "logout");
      completionFunction = "_openclaw_models_auth";
    } else {
      describedCommand = program
        .command("inspect")
        .alias("review")
        .description('Show John\'s "literal" $OPENCLAW_COMPLETION_LITERAL with `models auth list`');
      completionFunction = "_openclaw_root_completion";
    }
    const stdout = runZshScript(
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
      10_000,
    );
    if (stdout === undefined) {
      return;
    }
    const action = stdout.split("\0").filter(Boolean);
    expect(action.slice(0, 2)).toEqual(["_values", "command"]);
    for (const name of [describedCommand.name(), ...describedCommand.aliases()]) {
      expect(action).toContain(`${name}[${describedCommand.description()}]`);
    }
  });

  itUnix("keeps zsh choice boundaries literal", () => {
    const program = choiceProgram([
      "two words",
      'say "hello"',
      "it's literal",
      "literal $(printf OPENCLAW_COMPLETION_VALUE_EXECUTED >&2)",
      "literal `printf OPENCLAW_COMPLETION_VALUE_EXECUTED >&2`",
    ]);
    const stdout = runZshScript(`${getCompletionScript("zsh", program)}
_arguments() { printf '%s\\n' "$@"; }
_openclaw_root_completion
`);
    if (stdout === undefined) {
      return;
    }
    expect(stdout).toContain("two\\ words");
    expect(stdout).toContain('say\\ \\"hello\\"');
    expect(stdout).toContain("OPENCLAW_COMPLETION_VALUE_EXECUTED");
  });

  itUnix("completes zsh short clusters in groups and leaves", async (ctx) => {
    const probe = runZsh("zmodload zsh/zpty");
    if (probe.error && "code" in probe.error && probe.error.code === "ENOENT") {
      ctx.skip();
    }
    expect(probe).toMatchObject({ error: undefined, status: 0 });
    const program = new Command().name("openclaw");
    registerCompletionCli(program);
    registerAcpCli(program);
    const cases = [
      ["openclaw completion -ys f", "openclaw completion -ys fish"],
      ["openclaw completion -s f", "openclaw completion -s fish"],
      ["openclaw completion -yi --shell f", "openclaw completion -yi --shell fish"],
      ["openclaw acp -vv cl", "openclaw acp -vv client"],
    ];
    const tempDir = tempDirs.make("openclaw-zsh-completion-");
    await fs.writeFile(
      path.join(tempDir, ".zshrc"),
      `autoload -Uz compinit
compinit -u -D
${getCompletionScript("zsh", program)}
PROMPT='OPENCLAW_READY> '
openclaw_capture_completion() {
  print -r -- "OPENCLAW_RESULT:$BUFFER"
  print -r -- OPENCLAW_RESULT_END
  zle reset-prompt
}
zle -N openclaw_capture_completion
bindkey -e
bindkey '^X' openclaw_capture_completion
`,
      "utf8",
    );
    const result = runZsh(
      `zmodload zsh/zpty
zpty completion zsh -di
{
  zpty -r completion output '*OPENCLAW_READY>*'
${cases
  .map(
    ([line]) => `  zpty -w -n completion '${line}'$'\t\x18'
  zpty -r completion output '*OPENCLAW_RESULT_END*'
  print -r -- "$output"
  zpty -w -n completion $'\x15'`,
  )
  .join("\n")}
} always {
  zpty -d completion
}
`,
      {
        timeout: 15_000,
        env: { ...process.env, HOME: tempDir, ZDOTDIR: tempDir, TERM: "xterm" },
      },
    );
    expect(result).toMatchObject({ error: undefined, stderr: "", status: 0 });
    const completed = [...result.stdout.matchAll(/OPENCLAW_RESULT:([^\r\n]*)/g)].map((match) =>
      match[1]?.trimEnd(),
    );
    expect(completed).toEqual(cases.map(([, expected]) => expected));
  });

  it("defers zsh registration until compinit is available", async () => {
    if (process.platform === "win32") {
      return;
    }
    const probe = runZsh("exit 0");
    if (probe.error) {
      if (
        "code" in probe.error &&
        (probe.error.code === "ENOENT" || probe.error.code === "EACCES")
      ) {
        return;
      }
      throw probe.error;
    }
    const tempDir = tempDirs.make("openclaw-zsh-completion-");
    const scriptPath = path.join(tempDir, "openclaw.zsh");
    await fs.writeFile(scriptPath, getCompletionScript("zsh", createCompletionProgram()), "utf8");
    const result = runZsh(
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
      {
        env: {
          ...process.env,
          HOME: tempDir,
          ZDOTDIR: tempDir,
        },
      },
    );
    expect(result.stderr).not.toContain("command not found: compdef");
    expect(result.status).toBe(0);
  });

  itWithPowerShell("ignores PowerShell arguments after the cursor", async () => {
    const prefix = "openclaw completion --shell f";
    const program = documentedProgram();
    program.command("status").description("Root status").option("--json", "JSON output");
    expect(await powershell.complete(program, `${prefix} --yes`, prefix.length)).toEqual(["fish"]);
  });

  itWithPowerShell("matches literal PowerShell choice prefixes", async () => {
    expect(
      await powershell.complete(
        choiceProgram(["alpha", "a*literal", "a[bracket]"]),
        "openclaw --value A*",
      ),
    ).toEqual(["'a*literal'"]);
  });

  itWithFish.each([
    [
      "openclaw --profile work --log-level debug --container local g",
      () =>
        createCompletionProgram()
          .option("-p, --profile <name>")
          .option("--log-level <level>")
          .option("--container <name>"),
      expect.arrayContaining(["gateway"]),
    ],
    ["openclaw gateway -t=secret status -", createCompletionProgram, ["--json"]],
    [
      "openclaw gateway status restart -",
      () => {
        const program = createCompletionProgram();
        commandAt(program, "gateway", "status").argument("[query...]", "Search query");
        return program;
      },
      ["--json"],
    ],
    [
      "openclaw --color a",
      () => choiceProgram(["always", "never"], "-c, --color [when]", ""),
      expect.arrayContaining(["always"]),
    ],
  ] as const)("completes Fish line %s", (line, makeProgram, expected) => {
    expect(runFish(makeProgram(), line)).toEqual(expected);
  });

  it("does not require optional Fish option choices", () => {
    const program = choiceProgram(["auto", "manual"], "--mode [mode]", "Mode");
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

  itUnix("uses nearest inherited Bash choices", () => {
    const program = createAliasedCompletionProgram();
    program.addOption(
      new Option("--channel <channel>", "Update channel").choices(["stable", "beta"]),
    );
    commandAt(program, "cron").addOption(
      new Option("--channel <channel>", "Cron channel").choices(["production", "preview"]),
    );
    expect(runBash(program, ["openclaw", "cron", "create", "--channel=pre"])).toEqual([
      "--channel=preview",
    ]);
  });

  itUnix("keeps hyphenated Bash short-cluster values", () => {
    const program = new Command()
      .name("openclaw")
      .option("-v, --verbose", "Verbose output")
      .addOption(new Option("-m, --mode <mode>").choices(["-legacy"]))
      .exitOverride();
    program.parse(["-vm", "-legacy"], { from: "user" });
    expect(program.opts()).toEqual({ verbose: true, mode: "-legacy" });
    expect(runBash(program, ["openclaw", "-vm", "-le"])).toEqual(["-legacy"]);
  });

  itWithPowerShell.each([
    ["openclaw completion -ysf", "-ysfish"],
    ["openclaw completion -ys f", "fish"],
    ["openclaw completion --shell 'f", "fish"],
    ['openclaw completion --shell "f', "fish"],
    ["openclaw completion --shell 'f'", "fish"],
    ["openclaw completion --shell='f", "--shell=fish"],
  ])("completes PowerShell line %s", async (commandLine, expected) => {
    expect(await powershell.complete(documentedProgram(), commandLine)).toEqual([expected]);
  });
});
