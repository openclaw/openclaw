import {
  getCommandPathWithRootOptions,
  getPrimaryCommand,
  isHelpOrVersionInvocation,
  isRootHelpInvocation,
} from "./argv.js";
import { resolveGatewayCommandPath } from "./gateway-run-argv.js";
import { resolveCliParentCommandPath } from "./parent-command-path.js";

export function resolveCliArgvInvocation(argv: string[]): {
  argv: string[];
  commandPath: string[];
  primary: string | null;
  hasHelpOrVersion: boolean;
  isRootHelpInvocation: boolean;
} {
  return {
    argv,
    commandPath:
      resolveGatewayCommandPath(argv) ??
      resolveCliParentCommandPath(argv) ??
      getCommandPathWithRootOptions(argv, 2),
    primary: getPrimaryCommand(argv),
    hasHelpOrVersion: isHelpOrVersionInvocation(argv),
    isRootHelpInvocation: isRootHelpInvocation(argv),
  };
}
