// Shell completion generation, cache writing, and install command registration.
import fs from "node:fs/promises";
import path from "node:path";
import { Command, Option } from "commander";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { routeLogsToStderr } from "../logging/console.js";
import {
  buildFishOptionCompletionLine,
  buildFishSubcommandCompletionLine,
} from "./completion-fish.js";
import {
  COMPLETION_SHELLS,
  COMPLETION_SKIP_PLUGIN_COMMANDS_ENV,
  installCompletion,
  isCompletionShell,
  resolveCompletionCachePath,
  resolveShellFromEnv,
  type CompletionShell,
} from "./completion-runtime.js";
import { getCoreCliCommandNames, registerCoreCliByName } from "./program/command-registry-core.js";
import { getProgramContext } from "./program/program-context.js";
import { getSubCliEntries, registerSubCliByName } from "./program/register.subclis-core.js";

export function getCompletionScript(shell: CompletionShell, program: Command): string {
  if (shell === "zsh") {
    return generateZshCompletion(program);
  }
  if (shell === "bash") {
    return generateBashCompletion(program);
  }
  if (shell === "powershell") {
    return generatePowerShellCompletion(program);
  }
  return generateFishCompletion(program);
}

function splitOptionFlags(flags: string): string[] {
  return flags.split(/[ ,|]+/u).filter(Boolean);
}

function preferredCompletionFlag(flags: string): string {
  const parts = splitOptionFlags(flags);
  return parts.find((flag) => flag.startsWith("--")) ?? parts[0] ?? flags;
}

function commandCompletionNames(command: Command): string[] {
  return [...new Set([command.name(), ...command.aliases()])];
}

function subcommandCompletionNames(command: Command): string[] {
  return command.commands.flatMap(commandCompletionNames);
}

function commandPathVariants(commands: readonly Command[]): string[] {
  let variants = [""];
  for (const command of commands) {
    variants = variants.flatMap((prefix) =>
      commandCompletionNames(command).map((name) => (prefix ? `${prefix} ${name}` : name)),
    );
  }
  return variants;
}

function fishWords(values: readonly string[]): string {
  return values.join(" ");
}

function fishOptionFlags(options: Command["options"], wantsValue: boolean): string[] {
  return options.flatMap((option) => {
    if ((option.required || option.optional) !== wantsValue) {
      return [];
    }
    return splitOptionFlags(option.flags).filter((flag) => flag.startsWith("-"));
  });
}

function collectFishPathOptionFlags(
  program: Command,
  parents: readonly Command[],
  wantsValue: boolean,
): string[] {
  const flags = new Set(fishOptionFlags(program.options, wantsValue));
  for (const command of parents) {
    for (const flag of fishOptionFlags(command.options, wantsValue)) {
      flags.add(flag);
    }
  }
  return [...flags];
}

function generateFishPathHelper(rootCmd: string): string {
  // Fish needs a helper to ignore option values while matching nested command paths.
  return `
function __${rootCmd}_command_path_matches
  set -l expected
  set -l value_options
  set -l reading_value_options 0
  for arg in $argv
    if test "$arg" = "--"
      set reading_value_options 1
      continue
    end
    if test $reading_value_options -eq 1
      set -a value_options $arg
    else
      set -a expected $arg
    end
  end
  set -l tokens (commandline -opc)
  set -e tokens[1]
  set -l command_tokens
  set -l skip_next 0
  for token in $tokens
    if test $skip_next -eq 1
      set skip_next 0
      continue
    end
    set -l flag (string split -m1 "=" -- $token)[1]
    if contains -- $flag $value_options
      if not string match -q -- "*=*" $token
        set skip_next 1
      end
      continue
    end
    if string match -q -- "-*" $token
      continue
    end
    set -a command_tokens $token
  end
  for i in (seq (count $expected))
    if test "$command_tokens[$i]" != "$expected[$i]"
      return 1
    end
  end
  return 0
end
`;
}

function fishCommandPathCondition(
  program: Command,
  rootCmd: string,
  parents: readonly string[],
  parentCommands: readonly Command[],
): string {
  const valueOptions = collectFishPathOptionFlags(program, parentCommands, true);
  return `__${rootCmd}_command_path_matches ${parents.join(" ")} -- ${fishWords(valueOptions)}`.trimEnd();
}

async function writeCompletionCache(params: {
  program: Command;
  shells: CompletionShell[];
  binName: string;
}): Promise<void> {
  const firstShell = params.shells[0] ?? "zsh";
  const cacheDir = path.dirname(resolveCompletionCachePath(firstShell, params.binName));
  await fs.mkdir(cacheDir, { recursive: true });
  for (const shell of params.shells) {
    const script = getCompletionScript(shell, params.program);
    const targetPath = resolveCompletionCachePath(shell, params.binName);
    await fs.writeFile(targetPath, script, "utf-8");
  }
}

function writeCompletionRegistrationWarning(message: string): void {
  process.stderr.write(`[completion] ${message}\n`);
}

async function registerSubcommandsForCompletion(program: Command): Promise<void> {
  const entries = getSubCliEntries();
  for (const entry of entries) {
    if (entry.name === "completion") {
      continue;
    }
    try {
      await registerSubCliByName(program, entry.name, process.argv, { purpose: "completion" });
    } catch (error) {
      writeCompletionRegistrationWarning(
        `skipping subcommand \`${entry.name}\` while building completion cache: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export function registerCompletionCli(program: Command) {
  program
    .command("completion")
    .description("Generate shell completion script")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/completion", "docs.openclaw.ai/cli/completion")}\n`,
    )
    .addOption(
      new Option("-s, --shell <shell>", "Shell to generate completion for (default: zsh)").choices(
        COMPLETION_SHELLS,
      ),
    )
    .option("-i, --install", "Install completion script to shell profile")
    .option(
      "--write-state",
      "Write completion scripts to $OPENCLAW_STATE_DIR/completions (no stdout)",
    )
    .option("-y, --yes", "Skip confirmation (non-interactive)", false)
    .action(async (options) => {
      // Route logs to stderr so plugin loading messages do not corrupt
      // the completion script written to stdout.
      routeLogsToStderr();
      const shell = options.shell ?? "zsh";

      // Completion needs the full Commander command tree (including nested subcommands).
      // Our CLI defaults to lazy registration for perf; force-register core commands here.
      const ctx = getProgramContext(program);
      if (ctx) {
        for (const name of getCoreCliCommandNames()) {
          await registerCoreCliByName(program, ctx, name);
        }
      }

      // Eagerly register all subcommands except completion itself to build the full tree.
      await registerSubcommandsForCompletion(program);

      if (process.env[COMPLETION_SKIP_PLUGIN_COMMANDS_ENV] !== "1") {
        const { registerPluginCliCommandsFromValidatedConfig } = await import("../plugins/cli.js");
        await registerPluginCliCommandsFromValidatedConfig(program, undefined, undefined, {
          mode: "eager",
        });
      }

      if (options.writeState) {
        const writeShells = options.shell ? [shell] : [...COMPLETION_SHELLS];
        await writeCompletionCache({
          program,
          shells: writeShells,
          binName: program.name(),
        });
      }

      if (options.install) {
        const targetShell = options.shell ?? resolveShellFromEnv();
        await installCompletion(targetShell, Boolean(options.yes), program.name());
        return;
      }

      if (options.writeState) {
        return;
      }

      if (!isCompletionShell(shell)) {
        throw new Error(`Unsupported shell: ${shell}`);
      }
      const script = getCompletionScript(shell, program);
      process.stdout.write(script + "\n");
    });
}

function generateZshCompletion(program: Command): string {
  const rootCmd = program.name();
  const script = `
#compdef ${rootCmd}

_${rootCmd}_root_completion() {
  local -a commands
  local -a options
  
  _arguments -C \\
    ${generateZshArgs(program)} \\
    ${generateZshSubcmdList(program)} \\
    "*::arg:->args"

  case $state in
    (args)
      case $line[1] in
        ${program.commands.map((cmd) => `(${commandCompletionNames(cmd).join("|")}) _${rootCmd}_${cmd.name().replace(/-/g, "_")} ;;`).join("\n        ")}
      esac
      ;;
  esac
}

${generateZshSubcommands(program, rootCmd)}

_${rootCmd}_register_completion() {
  if (( ! $+functions[compdef] )); then
    return 0
  fi

  compdef _${rootCmd}_root_completion ${rootCmd}
  precmd_functions=(\${precmd_functions:#_${rootCmd}_register_completion})
  unfunction _${rootCmd}_register_completion 2>/dev/null
}

_${rootCmd}_register_completion
if (( ! $+functions[compdef] )); then
  typeset -ga precmd_functions
  if [[ -z "\${precmd_functions[(r)_${rootCmd}_register_completion]}" ]]; then
    precmd_functions+=(_${rootCmd}_register_completion)
  fi
fi
`;
  return script;
}

function generateZshArgs(cmd: Command): string {
  return (cmd.options || [])
    .map((opt) => {
      const flags = opt.flags.split(/[ ,|]+/);
      const name = flags.find((f) => f.startsWith("--")) || flags[0];
      const short = flags.find((f) => f.startsWith("-") && !f.startsWith("--"));
      const desc = escapeZshDoubleQuotedDescription(opt.description);
      if (short) {
        return `"(${name} ${short})"{${name},${short}}"[${desc}]"`;
      }
      return `"${name}[${desc}]"`;
    })
    .join(" \\\n    ");
}

function generateZshSubcmdList(cmd: Command): string {
  const list = cmd.commands
    .flatMap((c) => {
      const desc = c
        .description()
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "'\\''")
        .replace(/\[/g, "\\[")
        .replace(/\]/g, "\\]");
      return commandCompletionNames(c).map((name) => `'${name}[${desc}]'`);
    })
    .join(" ");
  return `"1: :_values 'command' ${list}"`;
}

function escapeZshDoubleQuotedDescription(description: string): string {
  return description
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replaceAll("`", "\\`")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

function generateZshSubcommands(program: Command, prefix: string): string {
  const segments: string[] = [];

  const visit = (current: Command, currentPrefix: string) => {
    for (const cmd of current.commands) {
      const cmdName = cmd.name();
      const nextPrefix = `${currentPrefix}_${cmdName.replace(/-/g, "_")}`;
      const funcName = `_${nextPrefix}`;

      visit(cmd, nextPrefix);

      const subCommands = cmd.commands;
      if (subCommands.length > 0) {
        segments.push(`
${funcName}() {
  local -a commands
  local -a options
  
  _arguments -C \\
    ${generateZshArgs(cmd)} \\
    ${generateZshSubcmdList(cmd)} \\
    "*::arg:->args"

  case $state in
    (args)
      case $line[1] in
        ${subCommands.map((sub) => `(${commandCompletionNames(sub).join("|")}) ${funcName}_${sub.name().replace(/-/g, "_")} ;;`).join("\n        ")}
      esac
      ;;
  esac
}
`);
        continue;
      }

      segments.push(`
${funcName}() {
  _arguments -C \\
    ${generateZshArgs(cmd)}
}
`);
    }
  };

  visit(program, prefix);
  return segments.join("");
}

function generateBashCompletion(program: Command): string {
  const rootCmd = program.name();
  const rootCompletions = [
    ...subcommandCompletionNames(program),
    ...program.options.map((o) => preferredCompletionFlag(o.flags)),
  ];

  return `
_${rootCmd}_completion() {
    local cur opts command_path word i
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    opts="${rootCompletions.join(" ")}"
    command_path=""

    for ((i = 1; i < COMP_CWORD; i++)); do
        word="\${COMP_WORDS[i]}"
        if [[ \${word} == -* ]]; then
            break
        fi
        if [[ -n "\${command_path}" ]]; then
            command_path+=" "
        fi
        command_path+="\${word}"
    done
    
    case "\${command_path}" in
${generateBashSubcommands(program)}
    esac

    if [[ \${cur} == -* ]] ; then
        COMPREPLY=( $(compgen -W "\${opts}" -- \${cur}) )
        return 0
    fi
    
    COMPREPLY=( $(compgen -W "\${opts}" -- \${cur}) )
}

complete -F _${rootCmd}_completion ${rootCmd}
`;
}

function generateBashSubcommands(program: Command): string {
  const segments: string[] = [];

  const visit = (cmd: Command, pathCommands: Command[]) => {
    const completions = [
      ...subcommandCompletionNames(cmd),
      ...cmd.options.map((o) => preferredCompletionFlag(o.flags)),
    ];
    const patterns = commandPathVariants(pathCommands)
      .map((pathValue) => `"${pathValue}"`)
      .join("|");
    segments.push(`      ${patterns})
        opts="${completions.join(" ")}"
        ;;`);

    for (const sub of cmd.commands) {
      visit(sub, [...pathCommands, sub]);
    }
  };

  for (const sub of program.commands) {
    visit(sub, [sub]);
  }

  return segments.join("\n");
}

function generatePowerShellCompletion(program: Command): string {
  const rootCmd = program.name();
  const segments: string[] = [];
  const formatPowerShellArray = (entries: string[]) =>
    entries.length > 0 ? `@(${entries.map((entry) => `'${entry}'`).join(",")})` : "@()";

  const visit = (cmd: Command, pathCommands: Command[]) => {
    // Command completion for this level
    const subCommands = subcommandCompletionNames(cmd);
    const options = cmd.options.map((o) => preferredCompletionFlag(o.flags));
    const allCompletions = formatPowerShellArray([...subCommands, ...options]);

    if (pathCommands.length > 0 && [...subCommands, ...options].length > 0) {
      for (const variant of commandPathVariants(pathCommands)) {
        segments.push(`
            if ($commandPath -eq '${variant}') {
                $completions = ${allCompletions}
                $completions | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
                    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterName', $_)
                }
            }
`);
      }
    }

    for (const sub of cmd.commands) {
      visit(sub, [...pathCommands, sub]);
    }
  };

  visit(program, []);
  const rootBody = segments.join("");

  return `
Register-ArgumentCompleter -Native -CommandName ${rootCmd} -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)
    
    $commandElements = $commandAst.CommandElements
    $commandPath = ""
    
    # Reconstruct command path (simple approximation)
    # Skip the executable name
    for ($i = 1; $i -lt $commandElements.Count; $i++) {
        $element = $commandElements[$i].Extent.Text
        if ($element -like "-*") { break }
        if ($i -eq $commandElements.Count - 1 -and $wordToComplete -ne "") { break } # Don't include current word being typed
        $commandPath += "$element "
    }
    $commandPath = $commandPath.Trim()
    
    # Root command
    if ($commandPath -eq "") {
         $completions = ${formatPowerShellArray([
           ...subcommandCompletionNames(program),
           ...program.options.map((option) => preferredCompletionFlag(option.flags)),
         ])}
         $completions | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
            [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterName', $_)
         }
    }
    
    ${rootBody}
}
`;
}

function generateFishCompletion(program: Command): string {
  const rootCmd = program.name();
  const segments: string[] = [generateFishPathHelper(rootCmd)];

  const visit = (cmd: Command, parents: string[], parentCommands: Command[]) => {
    // Root logic
    if (parents.length === 0) {
      // Subcommands of root
      for (const sub of cmd.commands) {
        for (const name of commandCompletionNames(sub)) {
          segments.push(
            buildFishSubcommandCompletionLine({
              rootCmd,
              condition: "__fish_use_subcommand",
              name,
              description: sub.description(),
            }),
          );
        }
      }
      // Options of root
      for (const opt of cmd.options) {
        segments.push(
          buildFishOptionCompletionLine({
            rootCmd,
            condition: "__fish_use_subcommand",
            flags: opt.flags,
            description: opt.description,
          }),
        );
      }
    } else {
      const condition = fishCommandPathCondition(program, rootCmd, parents, parentCommands);
      // Subcommands
      for (const sub of cmd.commands) {
        for (const name of commandCompletionNames(sub)) {
          segments.push(
            buildFishSubcommandCompletionLine({
              rootCmd,
              condition,
              name,
              description: sub.description(),
            }),
          );
        }
      }
      // Options
      for (const opt of cmd.options) {
        segments.push(
          buildFishOptionCompletionLine({
            rootCmd,
            condition,
            flags: opt.flags,
            description: opt.description,
          }),
        );
      }
    }

    for (const sub of cmd.commands) {
      for (const variant of commandCompletionNames(sub)) {
        visit(
          sub,
          parents.length === 0 ? [variant] : [...parents, variant],
          parents.length === 0 ? [sub] : [...parentCommands, sub],
        );
      }
    }
  };

  visit(program, [], []);
  return segments.join("");
}
