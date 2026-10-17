import type { DatabaseProcessRole } from "../infra/database-engine/admission-scope.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { rewriteUpdateFlagArgv } from "./argv.js";
import { isGatewayRunInvocationArgv } from "./gateway-run-argv.js";

export function resolveCliDatabaseProcessRole(rawArgv: string[]): DatabaseProcessRole {
  const argv = rewriteUpdateFlagArgv(rawArgv);
  // Interactive setup owns one-shot state work; any Gateway it starts has its own process.
  return !resolveCliArgvInvocation(argv).hasHelpOrVersion && isGatewayRunInvocationArgv(argv)
    ? "gateway"
    : "cli-oneshot";
}
