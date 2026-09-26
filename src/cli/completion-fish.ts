// Fish completion line builders for subcommands and options.
import type { ShellCompletionCommandTree } from "./completion-command-tree.js";

function escapeFishDescription(value: string): string {
  return value.replace(/'/g, "'\\''");
}

function quoteFishCompletionChoice(value: string): string {
  // Fish evaluates -a expressions during completion; single quotes keep choices as inert values.
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function escapeFishDoubleQuotedArgument(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$");
}

export function generateFishPathHelper(rootCmd: string, tree: ShellCompletionCommandTree): string {
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

export function fishCommandPathCondition(rootCmd: string, parents: readonly string[]): string {
  return `__${rootCmd}_command_path_matches ${parents.join(" ")}`.trimEnd();
}

export function buildFishSubcommandCompletionLine(params: {
  rootCmd: string;
  condition: string;
  name: string;
  description: string;
}): string {
  const desc = escapeFishDescription(params.description);
  return `complete -c ${params.rootCmd} -n "${params.condition}" -a "${params.name}" -d '${desc}'\n`;
}

export function buildFishOptionCompletionLine(params: {
  rootCmd: string;
  condition: string;
  flags: readonly string[];
  description: string;
  requiresValue?: boolean;
  choices?: readonly string[];
}): string {
  const desc = escapeFishDescription(params.description);
  const choices = params.choices?.length
    ? escapeFishDoubleQuotedArgument(params.choices.map(quoteFishCompletionChoice).join(" "))
    : undefined;
  let line = `complete -c ${params.rootCmd} -n "${params.condition}"`;
  for (const flag of params.flags) {
    line += flag.startsWith("--") ? ` -l ${flag.slice(2)}` : ` -s ${flag.slice(1)}`;
  }
  if (params.requiresValue) {
    line += " -r";
  }
  if (choices) {
    line += ` -f -a "${choices}"`;
  }
  line += ` -d '${desc}'\n`;
  if (choices && !params.requiresValue) {
    // Fish only binds separated values to required options; keep Commander optional values optional.
    const pendingOption = `contains -- (commandline -opc)[-1] ${params.flags.join(" ")}`;
    line += `complete -c ${params.rootCmd} -n "${params.condition}; and ${pendingOption}" -f -a "${choices}" -d '${desc}'\n`;
  }
  return line;
}
