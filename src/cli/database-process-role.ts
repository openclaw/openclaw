import type { DatabaseProcessRole } from "../infra/database-engine/admission-scope.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { hasFlag, rewriteUpdateFlagArgv } from "./argv.js";
import { isGatewayRunInvocationArgv } from "./gateway-run-argv.js";

export function resolveCliDatabaseProcessRole(rawArgv: string[]): DatabaseProcessRole {
  const argv = rewriteUpdateFlagArgv(rawArgv);
  const { primary, commandPath, hasHelpOrVersion } = resolveCliArgvInvocation(argv);
  if (hasHelpOrVersion) {
    return "cli-oneshot";
  }
  // Interactive setup can host a session Gateway on containers without user systemd.
  const mayOnboard =
    primary === null ||
    (commandPath.length === 1 && ["onboard", "setup", "crestodian"].includes(primary));
  return isGatewayRunInvocationArgv(argv) ||
    (mayOnboard && !hasFlag(argv, "--non-interactive") && !hasFlag(argv, "--baseline"))
    ? "gateway"
    : "cli-oneshot";
}
