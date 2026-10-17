import { getCommandPositionalsWithRootOptions } from "../infra/cli-root-options.js";
import type { DatabaseProcessRole } from "../infra/database-engine/admission-scope.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { hasFlag, rewriteUpdateFlagArgv } from "./argv.js";
import { isGatewayRunInvocationArgv } from "./gateway-run-argv.js";

export function resolveCliDatabaseProcessRole(rawArgv: string[]): DatabaseProcessRole {
  const argv = rewriteUpdateFlagArgv(rawArgv);
  const { primary, hasHelpOrVersion } = resolveCliArgvInvocation(argv);
  if (hasHelpOrVersion) {
    return "cli-oneshot";
  }
  // Recommendations accepts only the parent's JSON flag, not onboarding options.
  const isRecommendations =
    primary === "onboard" &&
    getCommandPositionalsWithRootOptions(argv, {
      commandPath: ["onboard"],
      booleanFlags: ["--json"],
      maxPositionals: 1,
      mode: "command-path",
    })?.[0] === "recommendations";
  // Interactive setup can host a session Gateway on containers without user systemd.
  const mayOnboard =
    primary === null ||
    (["onboard", "setup", "crestodian"].includes(primary) && !isRecommendations);
  return isGatewayRunInvocationArgv(argv) ||
    (mayOnboard && !hasFlag(argv, "--non-interactive") && !hasFlag(argv, "--baseline"))
    ? "gateway"
    : "cli-oneshot";
}
