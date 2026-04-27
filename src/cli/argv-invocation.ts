import {
  getCommandPathWithRootOptions,
  getPrimaryCommand,
  hasHelpOrVersion,
  isRootHelpInvocation,
} from "./argv.js";

function getAgentExecCommandPath(argv: string[]): string[] {
  const args = argv.slice(2);
  const path: string[] = [];
  for (const arg of args) {
    if (!arg || arg === "--") {
      break;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    path.push(arg);
    if (path.length >= 1) {
      break;
    }
  }
  return path;
}

export type CliArgvInvocation = {
  argv: string[];
  commandPath: string[];
  primary: string | null;
  hasHelpOrVersion: boolean;
  isRootHelpInvocation: boolean;
};

export function resolveCliArgvInvocation(argv: string[]): CliArgvInvocation {
  const primary = getPrimaryCommand(argv);
  return {
    argv,
    commandPath:
      primary === "agent-exec"
        ? getAgentExecCommandPath(argv)
        : getCommandPathWithRootOptions(argv, 2),
    primary,
    hasHelpOrVersion: hasHelpOrVersion(argv),
    isRootHelpInvocation: isRootHelpInvocation(argv),
  };
}
