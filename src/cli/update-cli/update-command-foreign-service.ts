import path from "node:path";
import type { GatewayServiceCommandConfig } from "../../daemon/service-types.js";
import { GIT_RELEASE_LAUNCHER } from "../../infra/git-release-paths.js";
import { formatCliCommand } from "../command-format.js";

/**
 * Why update and repair leave a service they do not own untouched. A Git release-mode
 * service starts the release launcher; until its release can be tied to this checkout,
 * the service is reported as unverified, not as another installation's.
 */
export function formatForeignServiceSkip(
  command: Pick<GatewayServiceCommandConfig, "programArguments"> | null | undefined,
  env: NodeJS.ProcessEnv,
): string {
  const launcher = command?.programArguments.find(
    (arg) => path.basename(arg) === GIT_RELEASE_LAUNCHER,
  );
  return launcher
    ? `Gateway service management skipped: the service starts the Git release launcher ${launcher}, and this checkout cannot yet confirm that the release it runs is its own, so the service was left untouched. Run \`${formatCliCommand("openclaw triage", env)}\` for an agent to inspect it.`
    : "Gateway service management skipped: the service belongs to a different OpenClaw installation and was left untouched.";
}
