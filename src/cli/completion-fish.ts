// Fish completion line builders for subcommands and options.
function escapeFishDescription(value: string): string {
  return value.replace(/'/g, "'\\''");
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
  shortFlag?: string;
  longFlag?: string;
  description: string;
}): string {
  const desc = escapeFishDescription(params.description);
  let line = `complete -c ${params.rootCmd} -n "${params.condition}"`;
  if (params.shortFlag) {
    line += ` -s ${params.shortFlag.slice(1)}`;
  }
  if (params.longFlag) {
    line += ` -l ${params.longFlag.slice(2)}`;
  }
  line += ` -d '${desc}'\n`;
  return line;
}
