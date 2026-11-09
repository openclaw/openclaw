import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { theme } from "../../packages/terminal-core/src/theme.js";

export function formatDocsHelp(path: string): string {
  return `\n${theme.muted("Docs:")} ${formatDocsLink(path, `docs.openclaw.ai${path}`)}\n`;
}

type HelpExample = readonly [command: string, description: string];

export function formatHelpExamples(examples: ReadonlyArray<HelpExample>, inline = false): string {
  return examples
    .map(([command, description]) => {
      const formattedCommand = `  ${theme.command(command)}`;
      if (inline) {
        return description
          ? `${formattedCommand} ${theme.muted(`# ${description}`)}`
          : formattedCommand;
      }
      return `${formattedCommand}\n    ${theme.muted(description)}`;
    })
    .join("\n");
}
