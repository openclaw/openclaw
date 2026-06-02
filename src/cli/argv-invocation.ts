import {
  getCommandPathWithRootOptions,
  getPrimaryCommand,
  isHelpOrVersionInvocation,
  isRootHelpInvocation,
} from "./argv.js";

/** Normalized CLI invocation facts shared by registration, routing, and startup policy. */
export type CliArgvInvocation = {
  argv: string[];
  commandPath: string[];
  primary: string | null;
  hasHelpOrVersion: boolean;
  isRootHelpInvocation: boolean;
};

/** Resolve command path and help/version flags from raw process-style argv. */
export function resolveCliArgvInvocation(argv: string[]): CliArgvInvocation {
  return {
    argv,
    commandPath: getCommandPathWithRootOptions(argv, 2),
    primary: getPrimaryCommand(argv),
    hasHelpOrVersion: isHelpOrVersionInvocation(argv),
    isRootHelpInvocation: isRootHelpInvocation(argv),
  };
}
