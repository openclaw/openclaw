import fs from "node:fs/promises";
import { Option, type Command } from "commander";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { isInvalidConfigError } from "../config/io.invalid-config.js";
import { routeLogsToStderr } from "../logging/console.js";
import { formatConsoleDiagnosticLine } from "../logging/json-console-line.js";
import { generateBashCompletion } from "./completion-bash.js";
import {
  collectShellCompletionCommandTree,
  commandNameVariants,
  completionOptions,
  visibleCompletionCommands,
  type ShellCompletionCommandTree,
} from "./completion-command-tree.js";
import {
  COMPLETION_SHELLS,
  COMPLETION_SKIP_PLUGIN_COMMANDS_ENV,
  installCompletion,
  isCompletionShell,
  resolveCompletionCachePath,
  resolveShellFromEnv,
  type CompletionShell,
} from "./completion-runtime.js";
import { publishOutputFileAtomically } from "./output-file.runtime.js";
import { getCoreCliCompletionGroups } from "./program/command-registry-core.js";
import { getProgramContext } from "./program/program-context.js";
import { removeCommandGroupNames } from "./program/register-command-groups.js";
import { getSubCliCompletionGroups } from "./program/register.subclis.js";

export function getCompletionScript(shell: CompletionShell, program: Command): string {
  return createCompletionScriptGenerator(program)(shell);
}

function createCompletionScriptGenerator(program: Command): (shell: CompletionShell) => string {
  let tree: ShellCompletionCommandTree | undefined;
  return (shell) => {
    if (shell === "zsh") {
      return generateZshCompletion(program);
    }
    tree ??= collectShellCompletionCommandTree(program);
    if (shell === "bash") {
      return generateBashCompletion(tree);
    }
    if (shell === "powershell") {
      return generatePowerShellCompletion(tree);
    }
    return generateFishCompletion(tree);
  };
}

function writeCompletionRegistrationWarning(message: string): void {
  const diagnostic = `[completion] ${message}`;
  process.stderr.write(`${formatConsoleDiagnosticLine({ level: "warn", message: diagnostic })}\n`);
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
      new Option(
        "-s, --shell <shell>",
        "Shell to generate completion for (default: detected)",
      ).choices(COMPLETION_SHELLS),
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

      // Cached installation needs only the existing script; loading the command tree can
      // introduce unrelated plugin failures before the cache can be checked or installed.
      if (options.install && !options.writeState) {
        const targetShell = options.shell ?? resolveShellFromEnv();
        await installCompletion(targetShell, false, program.name());
        return;
      }

      const shell = options.shell ?? resolveShellFromEnv();

      // Completion needs the full Commander command tree (including nested subcommands).
      // Our CLI defaults to lazy registration for perf; force-register core commands here.
      const ctx = getProgramContext(program);
      if (ctx) {
        for (const entry of getCoreCliCompletionGroups(ctx)) {
          removeCommandGroupNames(program, entry);
          await entry.register(program);
        }
      }

      for (const { name, entry } of getSubCliCompletionGroups()) {
        try {
          removeCommandGroupNames(program, entry);
          await entry.register(program);
        } catch (error) {
          writeCompletionRegistrationWarning(
            `skipping subcommand \`${name}\` while building completion cache: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (process.env[COMPLETION_SKIP_PLUGIN_COMMANDS_ENV] !== "1") {
        const { registerPluginCliCommandsFromValidatedConfig } = await import("../plugins/cli.js");
        try {
          await registerPluginCliCommandsFromValidatedConfig(program, undefined, undefined, {
            mode: "eager",
          });
        } catch (error) {
          if (!isInvalidConfigError(error)) {
            throw error;
          }
          writeCompletionRegistrationWarning(`skipping plugin commands: ${error.message}`);
        }
      }

      if (options.writeState) {
        const writeShells = options.shell ? [shell] : [...COMPLETION_SHELLS];
        const binName = program.name();
        const generateScript = createCompletionScriptGenerator(program);
        for (const writeShell of writeShells) {
          const script = generateScript(writeShell);
          await publishOutputFileAtomically({
            filePath: resolveCompletionCachePath(writeShell, binName),
            tempPrefix: ".openclaw-completion-cache",
            writeTemp: async (tempPath) => {
              await fs.writeFile(tempPath, script, { encoding: "utf-8", flag: "wx" });
            },
          });
        }
      }

      if (options.install) {
        const targetShell = options.shell ?? resolveShellFromEnv();
        await installCompletion(targetShell, false, program.name());
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
  return `
#compdef ${rootCmd}

${generateZshCommandGroup(program, `_${rootCmd}_root_completion`, `_${rootCmd}`)}

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
}

function generateZshArgs(cmd: Command): string {
  return completionOptions(cmd)
    .map(({ option: opt, flags }) => {
      const name = flags.find((flag) => flag === opt.long) ?? flags[0] ?? opt.flags;
      const alternate = flags.find((flag) => flag !== name);
      // `_arguments` hides `!` specs but still skips their values when locating subcommands.
      const visibility = opt.hidden ? "!" : "";
      const desc = escapeZshDoubleQuotedDescription(opt.description);
      const choices = opt.argChoices?.map(escapeZshCompletionChoice).join(" ");
      const argument =
        opt.required || opt.optional
          ? `${opt.optional ? "::" : ":"}${opt.attributeName()}:${choices ? `(${choices})` : ""}`
          : "";
      if (alternate) {
        return `"${visibility}(${name} ${alternate})"{${name},${alternate}}"[${desc}]${argument}"`;
      }
      return `"${visibility}${name}[${desc}]${argument}"`;
    })
    .join(" \\\n    ");
}

function escapeZshCompletionChoice(choice: string): string {
  // `_arguments` parses this list after zsh parses the surrounding double-quoted spec.
  return escapeZshDoubleQuotedDescription(choice.replace(/([\\\s:()[\]{}*?!|&;<>"'$`])/g, "\\$1"));
}

function escapeZshDoubleQuotedDescription(description: string): string {
  return description.replace(/[\\$"`[\]]/g, "\\$&");
}

function generateZshCommandGroup(
  command: Command,
  functionName: string,
  childPrefix = functionName,
): string {
  const args = generateZshArgs(command);
  const list = visibleCompletionCommands(command)
    .flatMap((c) => {
      const desc = escapeZshDoubleQuotedDescription(c.description()).replace(/'/g, "'\\''");
      return commandNameVariants(c).map((name) => `'${name}[${desc}]'`);
    })
    .join(" ");
  return `${functionName}() {
  local -a commands
  local -a options
  
  _arguments -s -C \\
    ${args} \\
    "1: :_values 'command' ${list}" \\
    "*::arg:->args"

  case $state in
    (args)
      case $line[1] in
        ${command.commands.map((cmd) => `(${commandNameVariants(cmd).join("|")}) ${childPrefix}_${cmd.name().replace(/-/g, "_")} ;;`).join("\n        ")}
      esac
      ;;
  esac
}`;
}

function generateZshSubcommands(program: Command, prefix: string): string {
  return program.commands
    .map((cmd) => {
      const nextPrefix = `${prefix}_${cmd.name().replace(/-/g, "_")}`;
      const funcName = `_${nextPrefix}`;
      const body =
        cmd.commands.length > 0
          ? `\n${generateZshCommandGroup(cmd, funcName)}\n`
          : `
${funcName}() {
  _arguments -s -C \\
    ${generateZshArgs(cmd)}
}
`;
      return generateZshSubcommands(cmd, nextPrefix) + body;
    })
    .join("");
}

function generatePowerShellCompletion(tree: ShellCompletionCommandTree): string {
  const { root, descendants: contexts } = tree;
  const rootCmd = root.command.name();
  const formatPowerShellArray = (entries: string[]) =>
    entries.length > 0
      ? `@(${entries.map((entry) => `'${entry.replaceAll("'", "''")}'`).join(",")})`
      : "@()";
  const commandPathCases = contexts
    .flatMap((context) =>
      context.pathVariants.map(
        (pathSegments) => `            '${pathSegments.join(" ")}' {
                $commandPath = $candidatePath
                $valueOptions = ${formatPowerShellArray(context.valueOptions)}
            }`,
      ),
    )
    .join("\n");
  const commandPathUpdate = commandPathCases
    ? `        $candidatePath = if ($commandPath -eq '') { $element } else { "$commandPath $element" }
        switch ($candidatePath) {
${commandPathCases}
        }`
    : "";

  const completionBodies = contexts
    .filter((context) => context.completions.length > 0)
    .flatMap((context) => {
      const allCompletions = formatPowerShellArray(context.completions);
      return context.pathVariants
        .map((segments) => segments.join(" "))
        .filter(Boolean)
        .map(
          (fullPath) => `
            if ($commandPath -eq '${fullPath}') {
                $completions = ${allCompletions}
                $completions | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
                    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterName', $_)
                }
            }
`,
        );
    })
    .join("");
  const choiceCompletion = [root, ...contexts]
    .filter(({ valueChoices }) => valueChoices.length > 0)
    .flatMap(({ pathVariants, valueChoices }) => {
      const optionChoiceCases = valueChoices
        .map(
          ({
            flags,
            choices,
            requiresValue,
          }) => `        if ($choiceFlag -in ${formatPowerShellArray(flags)}) {
            $matchingChoices = @(${formatPowerShellArray(choices)} | Where-Object {
                $_.StartsWith($choicePrefix, [StringComparison]::OrdinalIgnoreCase)
            })
            $matchingChoices | ForEach-Object {
                $choiceValue = if ($_ -match '^[A-Za-z0-9_./:+-]+$') {
                    $_
                } else {
                    "'" + $_.Replace("'", "''") + "'"
                }
                $completionText = "$choiceCompletionPrefix$choiceValue"
                [System.Management.Automation.CompletionResult]::new($completionText, $_, 'ParameterValue', $_)
            }
            if (${requiresValue ? "$true" : "$matchingChoices.Count -gt 0 -or $choiceCompletionPrefix -ne '' -or $choicePrefix -notlike '-*'"}) {
                return
            }
        }`,
        )
        .join("\n");
      return pathVariants.map(
        (
          pathSegments,
        ) => `    if ($commandPath -eq '${pathSegments.join(" ").replaceAll("'", "''")}') {
${optionChoiceCases}
    }`,
      );
    })
    .join("\n");

  return `
Register-ArgumentCompleter -Native -CommandName ${rootCmd} -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)
    
    # Limit context to the cursor; command-path parsing below skips option operands.
    $commandElements = @($commandAst.CommandElements.Where({ $_.Extent.StartOffset -lt $cursorPosition }))
    $commandPath = ""
    $valueOptions = ${formatPowerShellArray(root.valueOptions)}
    $previousElementIndex = if ($wordToComplete -eq '') { $commandElements.Count - 1 } else { $commandElements.Count - 2 }
    $previousElement = if ($previousElementIndex -ge 1) { $commandElements[$previousElementIndex].Extent.Text } else { '' }
    $choiceFlag = $previousElement
    $choicePrefix = $wordToComplete
    # PowerShell retains quotes in wordToComplete, even for an unfinished literal.
    if ($wordToComplete -ne '' -and $commandElements[-1] -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
        $choicePrefix = $commandElements[-1].Value
    }
    $choiceCompletionPrefix = ''
    if ($wordToComplete -match '^(--[^=]+)=(.*)$') {
        $choiceFlag = $Matches[1]
        $choicePrefix = $Matches[2]
        $choiceCompletionPrefix = "$choiceFlag="
    }

    for ($i = 1; $i -lt $commandElements.Count; $i++) {
        $element = if ($commandElements[$i] -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
            $commandElements[$i].Value
        } else {
            $commandElements[$i].Extent.Text
        }
        if ($i -eq $commandElements.Count - 1 -and $wordToComplete -ne "") { break }
        if ($element -like "-*") {
            $flag = ($element -split '=', 2)[0]
            if ($element -notlike '*=*' -and $valueOptions -contains $flag) {
                $i++
            }
            continue
        }

${commandPathUpdate}
    }

    if ($previousElement -match '^-[^-].+$') {
        $shortGroup = $previousElement.Substring(1)
        for ($shortIndex = 0; $shortIndex -lt $shortGroup.Length; $shortIndex++) {
            $shortFlag = "-$($shortGroup[$shortIndex])"
            if ($valueOptions -contains $shortFlag) {
                if ($shortIndex -eq $shortGroup.Length - 1) {
                    $choiceFlag = $shortFlag
                }
                break
            }
        }
    }

    if ($wordToComplete -match '^-[^-].+$') {
        $shortGroup = $wordToComplete.Substring(1)
        for ($shortIndex = 0; $shortIndex -lt $shortGroup.Length; $shortIndex++) {
            $shortFlag = "-$($shortGroup[$shortIndex])"
            if ($valueOptions -contains $shortFlag) {
                $choiceFlag = $shortFlag
                $choicePrefix = $shortGroup.Substring($shortIndex + 1)
                $choiceCompletionPrefix = "-$($shortGroup.Substring(0, $shortIndex + 1))"
                break
            }
        }
    }

${choiceCompletion}
    
    # Root command
    if ($commandPath -eq "") {
         $completions = ${formatPowerShellArray(root.completions)}
         $completions | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
            [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterName', $_)
         }
    }
    
    ${completionBodies}
}
`;
}

function escapeFishDescription(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "'\\''");
}

function quoteFishCompletionChoice(value: string): string {
  // Fish evaluates -a expressions during completion; single quotes keep choices as inert values.
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function escapeFishDoubleQuotedArgument(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$");
}

function generateFishPathHelper(rootCmd: string, tree: ShellCompletionCommandTree): string {
  const paths = tree.descendants.flatMap((context) =>
    context.pathVariants.map((segments) => ({
      path: quoteFishCompletionChoice(segments.join(" ")),
      valueOptions: context.valueOptions.map(quoteFishCompletionChoice).join(" "),
    })),
  );
  const pathOptions = paths
    .map(
      ({ path, valueOptions }) => `      case ${path}\n        set value_options ${valueOptions}`,
    )
    .join("\n");
  const updatePath = paths.length
    ? `
    switch (string join " " $command_tokens)
${pathOptions}
    end`
    : "";
  const rejectDescendantCommands = paths.length
    ? `
  if test (count $command_tokens) -gt (count $expected)
    set -l next_index (math (count $expected) + 1)
    set -l candidate_path (string join " " $expected $command_tokens[$next_index])
    switch "$candidate_path"
      case ${paths.map(({ path }) => path).join(" ")}
        return 1
    end
  end`
    : "";
  // The destination's options cannot describe tokens before a shadowing child.
  // Advance the active option contract only after consuming each command word.
  return `
function __${rootCmd}_command_path_matches
  set -l expected $argv
  set -l value_options ${tree.root.valueOptions.map(quoteFishCompletionChoice).join(" ")}
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
${updatePath}
  end
  if test (count $expected) -gt 0
    for i in (seq (count $expected))
      if test "$command_tokens[$i]" != "$expected[$i]"
        return 1
      end
    end
  end
${rejectDescendantCommands}
  return 0
end
`;
}

function generateFishCompletion(tree: ShellCompletionCommandTree): string {
  const { root, descendants } = tree;
  const rootCmd = root.command.name();
  const segments: string[] = [generateFishPathHelper(rootCmd, tree)];

  for (const context of [root, ...descendants]) {
    const cmd = context.command;
    // One condition per alias-expanded parent path so completion keeps working
    // after the user typed an alias segment.
    const conditions = context.pathVariants.map((parents) =>
      `__${rootCmd}_command_path_matches ${parents.join(" ")}`.trimEnd(),
    );
    for (const condition of conditions) {
      for (const sub of visibleCompletionCommands(cmd)) {
        for (const name of commandNameVariants(sub)) {
          const description = escapeFishDescription(sub.description());
          segments.push(
            `complete -c ${rootCmd} -n "${condition}" -a "${name}" -d '${description}'\n`,
          );
        }
      }
      for (const { option: opt, flags } of completionOptions(cmd).filter(
        ({ option }) => !option.hidden,
      )) {
        const description = escapeFishDescription(opt.description);
        const choices = opt.argChoices?.length
          ? escapeFishDoubleQuotedArgument(opt.argChoices.map(quoteFishCompletionChoice).join(" "))
          : undefined;
        let line = `complete -c ${rootCmd} -n "${condition}"`;
        for (const flag of flags) {
          line += flag.startsWith("--") ? ` -l ${flag.slice(2)}` : ` -s ${flag.slice(1)}`;
        }
        if (opt.required) {
          line += " -r";
        }
        if (choices) {
          line += ` -f -a "${choices}"`;
        }
        line += ` -d '${description}'\n`;
        if (choices && !opt.required) {
          // Fish only binds separated values to required options; keep Commander optional values optional.
          const pendingOption = `contains -- (commandline -opc)[-1] ${flags.join(" ")}`;
          line += `complete -c ${rootCmd} -n "${condition}; and ${pendingOption}" -f -a "${choices}" -d '${description}'\n`;
        }
        segments.push(line);
      }
    }
  }
  return segments.join("");
}
