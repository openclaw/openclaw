import { theme } from "../terminal/theme.js";
import { replaceCliName } from "./cli-name.js";

export type HelpExample = readonly [command: string, description: string];

function formatHelpExample(command: string, description: string): string {
  return `  ${theme.command(replaceCliName(command))}\n    ${theme.muted(description)}`;
}

function formatHelpExampleLine(command: string, description: string): string {
  const cmd = replaceCliName(command);
  if (!description) {
    return `  ${theme.command(cmd)}`;
  }
  return `  ${theme.command(cmd)} ${theme.muted(`# ${description}`)}`;
}

export function formatHelpExamples(examples: ReadonlyArray<HelpExample>, inline = false): string {
  const formatter = inline ? formatHelpExampleLine : formatHelpExample;
  return examples.map(([command, description]) => formatter(command, description)).join("\n");
}
